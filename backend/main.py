import asyncio
import json
import os
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

app = FastAPI(title="AI Ticket Triage API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TicketCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=4000)


class Ticket(BaseModel):
    id: str
    title: str
    description: str
    status: str
    summary: Optional[str] = None
    suggested_reply: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    error: Optional[str] = None


tickets: Dict[str, Ticket] = {}
ticket_lock = asyncio.Lock()
connections: Dict[str, Set[WebSocket]] = defaultdict(set)
connections_lock = asyncio.Lock()

openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def broadcast(ticket_id: str, payload: dict) -> None:
    """Send a JSON payload to all WebSocket listeners for a ticket."""
    message = json.dumps(payload)
    async with connections_lock:
        websockets = list(connections.get(ticket_id, set()))
    dead_connections: List[WebSocket] = []
    for ws in websockets:
        try:
            await ws.send_text(message)
        except Exception:
            dead_connections.append(ws)
    if dead_connections:
        async with connections_lock:
            for ws in dead_connections:
                connections[ticket_id].discard(ws)


async def broadcast_status(ticket_id: str, status: str, error: Optional[str] = None) -> None:
    await broadcast(
        ticket_id,
        {
            "type": "status",
            "ticketId": ticket_id,
            "status": status,
            "error": error,
        },
    )


async def process_ticket(ticket_id: str) -> None:
    """Call the LLM to summarize and draft a reply, streaming tokens to clients."""
    if not openai_client:
        await mark_ticket_error(ticket_id, "Missing OPENAI_API_KEY")
        return

    async with ticket_lock:
        ticket = tickets.get(ticket_id)
    if not ticket:
        return

    await broadcast_status(ticket_id, "processing")

    prompt = (
        "You are a concise support assistant. Given a support ticket, return JSON with keys "
        '"summary" (one sentence) and "suggested_reply" (short, actionable response).'
    )

    messages = [
        {"role": "system", "content": prompt},
        {
            "role": "user",
            "content": f"Title: {ticket.title}\nDescription: {ticket.description}",
        },
    ]

    content_buffer = ""
    try:
        stream = await openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=messages,
            temperature=0.3,
            stream=True,
            response_format={"type": "json_object"},
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta
            piece = delta.content or ""
            if piece:
                content_buffer += piece
                await broadcast(
                    ticket_id,
                    {
                        "type": "token",
                        "ticketId": ticket_id,
                        "token": piece,
                    },
                )
    except Exception as exc:  # broad catch to surface streaming errors
        await mark_ticket_error(ticket_id, f"LLM error: {exc}")
        return

    try:
        parsed = json.loads(content_buffer)
    except json.JSONDecodeError:
        await mark_ticket_error(ticket_id, "Could not parse LLM JSON response")
        return

    summary = parsed.get("summary") or ""
    suggested_reply = parsed.get("suggested_reply") or parsed.get("reply") or ""

    await update_ticket(
        ticket_id,
        status="done",
        summary=summary,
        suggested_reply=suggested_reply,
        error=None,
    )
    await broadcast(
        ticket_id,
        {
            "type": "complete",
            "ticketId": ticket_id,
            "summary": summary,
            "suggested_reply": suggested_reply,
        },
    )
    await broadcast_status(ticket_id, "done")


async def mark_ticket_error(ticket_id: str, error: str) -> None:
    await update_ticket(ticket_id, status="error", error=error)
    await broadcast_status(ticket_id, "error", error=error)


async def update_ticket(
    ticket_id: str,
    *,
    status: Optional[str] = None,
    summary: Optional[str] = None,
    suggested_reply: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    async with ticket_lock:
        ticket = tickets.get(ticket_id)
        if not ticket:
            return
        updated = ticket.model_copy()
        if status:
            updated.status = status
        if summary is not None:
            updated.summary = summary
        if suggested_reply is not None:
            updated.suggested_reply = suggested_reply
        updated.updated_at = utc_now()
        if error is not None:
            updated.error = error
        tickets[ticket_id] = updated


@app.post("/tickets", response_model=Ticket)
async def create_ticket(payload: TicketCreate, background_tasks: BackgroundTasks) -> Ticket:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=400, detail="OPENAI_API_KEY is not set")

    ticket_id = str(uuid.uuid4())
    now = utc_now()
    ticket = Ticket(
        id=ticket_id,
        title=payload.title,
        description=payload.description,
        status="processing",
        summary=None,
        suggested_reply=None,
        created_at=now,
        updated_at=now,
        error=None,
    )
    async with ticket_lock:
        tickets[ticket_id] = ticket

    background_tasks.add_task(process_ticket, ticket_id)
    return ticket


@app.get("/tickets", response_model=List[Ticket])
async def list_tickets() -> List[Ticket]:
    async with ticket_lock:
        return list(tickets.values())


@app.get("/tickets/{ticket_id}", response_model=Ticket)
async def get_ticket(ticket_id: str) -> Ticket:
    async with ticket_lock:
        ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


@app.websocket("/ws/tickets/{ticket_id}")
async def ticket_websocket(websocket: WebSocket, ticket_id: str) -> None:
    async with ticket_lock:
        ticket = tickets.get(ticket_id)
    if not ticket:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    async with connections_lock:
        connections[ticket_id].add(websocket)

    await websocket.send_text(
        json.dumps(
            {
                "type": "snapshot",
                "ticketId": ticket_id,
                "ticket": jsonable_encoder(ticket),
            }
        )
    )

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        async with connections_lock:
            connections[ticket_id].discard(websocket)
    except Exception:
        async with connections_lock:
            connections[ticket_id].discard(websocket)
