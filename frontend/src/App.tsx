import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Ticket = {
  id: string
  title: string
  description: string
  status: 'processing' | 'done' | 'error' | 'new'
  summary?: string | null
  suggested_reply?: string | null
  created_at: string
  updated_at: string
  error?: string | null
}

type WsMessage =
  | { type: 'snapshot'; ticketId: string; ticket: Ticket }
  | { type: 'status'; ticketId: string; status: Ticket['status']; error?: string | null }
  | { type: 'token'; ticketId: string; token: string }
  | { type: 'complete'; ticketId: string; summary: string; suggested_reply: string }

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000'
const WS_BASE = API_BASE.replace(/^http/i, 'ws')

function App() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle')
  const [streamBuffer, setStreamBuffer] = useState('')

  const selectedTicket = useMemo(() => tickets.find((t) => t.id === selectedId) ?? null, [selectedId, tickets])

  useEffect(() => {
    const fetchTickets = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API_BASE}/tickets`)
        if (!res.ok) throw new Error(`List failed: ${res.status}`)
        const data: Ticket[] = await res.json()
        setTickets(data)
      } catch (err: any) {
        setError(err.message ?? 'Failed to load tickets')
      } finally {
        setLoading(false)
      }
    }
    fetchTickets()
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setWsStatus('idle')
      return
    }
    setStreamBuffer('')
    const ws = new WebSocket(`${WS_BASE}/ws/tickets/${selectedId}`)
    setWsStatus('connecting')

    ws.onopen = () => setWsStatus('connected')
    ws.onerror = () => setWsStatus('error')
    ws.onclose = () => setWsStatus('closed')
    ws.onmessage = (event) => {
      try {
        const message: WsMessage = JSON.parse(event.data)
        handleWsMessage(message)
      } catch (err) {
        console.error('WS parse error', err)
      }
    }

    return () => {
      ws.close()
    }
  }, [selectedId])

  const handleWsMessage = (message: WsMessage) => {
    if (message.type === 'token') {
      setStreamBuffer((prev) => prev + message.token)
      return
    }

    if (message.type === 'complete') {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === message.ticketId
            ? { ...t, summary: message.summary, suggested_reply: message.suggested_reply, status: 'done' }
            : t,
        ),
      )
      return
    }

    if (message.type === 'status') {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === message.ticketId ? { ...t, status: message.status, error: message.error ?? null } : t,
        ),
      )
      return
    }

    if (message.type === 'snapshot') {
      setTickets((prev) => {
        const exists = prev.some((t) => t.id === message.ticketId)
        if (exists) {
          return prev.map((t) => (t.id === message.ticketId ? message.ticket : t))
        }
        return [message.ticket, ...prev]
      })
    }
  }

  const createTicket = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    if (!formTitle.trim() || !formDescription.trim()) {
      setError('Title and description are required.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`${API_BASE}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: formTitle.trim(), description: formDescription.trim() }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Create failed: ${res.status} ${text}`)
      }
      const ticket: Ticket = await res.json()
      setTickets((prev) => [ticket, ...prev])
      setSelectedId(ticket.id)
      setFormTitle('')
      setFormDescription('')
      setStreamBuffer('')
    } catch (err: any) {
      setError(err.message ?? 'Failed to create ticket')
    } finally {
      setCreating(false)
    }
  }

  const statusBadge = (status: Ticket['status']) => {
    if (status === 'done') return 'success'
    if (status === 'error') return 'error'
    return 'pending'
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">AI Triage Sandbox</p>
          <h1>Support tickets with streaming LLM replies</h1>
          <p className="lede">
            Submit a ticket, watch the backend call OpenAI, and stream the JSON reply (summary + suggested reply) over
            WebSockets.
          </p>
        </div>
      </header>

      <main className="layout">
        <section className="panel panel--fixed">
          <div className="panel-header">
            <h2>Create ticket</h2>
          </div>
          <form className="form" onSubmit={createTicket}>
            <label>
              Title
              <input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Login not working"
                required
              />
            </label>
            <label>
              Description
              <textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Describe the issue so the LLM can triage it."
                rows={4}
                required
              />
            </label>
            <button type="submit" disabled={creating}>
              {creating ? 'Submitting…' : 'Submit & stream'}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        </section>

        <section className="panel panel--fixed">
          <div className="panel-header">
            <div>
              <h2>Tickets</h2>
              <p className="muted">{loading ? 'Loading…' : `${tickets.length} total`}</p>
            </div>
            <button className="ghost" onClick={() => window.location.reload()}>
              Refresh
            </button>
          </div>
          <div className={`ticket-list ${tickets.length === 0 ? 'empty' : ''}`}>
            {tickets.length === 0 && <p className="muted">No tickets yet. Create one to start streaming.</p>}
            {tickets.map((ticket) => (
              <article
                key={ticket.id}
                className={`ticket ${selectedId === ticket.id ? 'active' : ''}`}
                onClick={() => setSelectedId(ticket.id)}
              >
                <div className="ticket-head">
                  <div>
                    <p className="ticket-title">{ticket.title}</p>
                    <p className="muted small">{new Date(ticket.created_at).toLocaleString()}</p>
                  </div>
                  <span className={`badge ${statusBadge(ticket.status)}`}>{ticket.status}</span>
                </div>
                <p className="ticket-desc">{ticket.description}</p>
                {ticket.error && <p className="error small">Error: {ticket.error}</p>}
              </article>
            ))}
          </div>
        </section>

        <section className="panel wide">
          <div className="panel-header">
            <div>
              <h2>Live stream</h2>
              <p className="muted small">
                WS: {wsStatus}
                {selectedTicket ? ` • Ticket ${selectedTicket.id.slice(0, 8)}` : ' • Pick a ticket'}
              </p>
            </div>
          </div>
          {!selectedTicket && <p className="muted">Select a ticket to watch the stream.</p>}
          {selectedTicket && (
            <div className="stream">
              <div className="stream-block">
                <h3>Token stream</h3>
                <div className="code">{streamBuffer || 'Waiting for tokens…'}</div>
              </div>
              <div className="stream-block grid">
                <div>
                  <h3>Summary</h3>
                  <p className="card-text">{selectedTicket.summary ?? 'Pending…'}</p>
                </div>
                <div>
                  <h3>Suggested reply</h3>
                  <p className="card-text">{selectedTicket.suggested_reply ?? 'Pending…'}</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
