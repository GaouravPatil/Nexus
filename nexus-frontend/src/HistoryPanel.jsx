import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  Database,
  Search,
  X,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Zap,
  Wind,
  Bot,
  Gem,
  Layers,
  RotateCw,
  Brain,
  Trash2,
  LogIn
} from 'lucide-react'
import { supabase } from './supabaseClient.js'
import './HistoryPanel.css'

const API_URL = import.meta.env.VITE_API_URL || 'https://nexus-fftl.onrender.com'

const HISTORY_URL = `${API_URL}/history`
const MEMORIES_URL = `${API_URL}/memories`

const PROVIDER_COLORS = {
  groq: '#D97757',
  mistral: '#6E8EF0',
  chatgpt: '#10a37f',
  gemini: '#E8A820',
  ensemble: '#c084fc',
}

const MODEL_ICONS = {
  auto: Sparkles,
  groq: Zap,
  mistral: Wind,
  chatgpt: Bot,
  gemini: Gem,
  ensemble: Layers,
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function HistoryPanel({ onClose, session }) {
  const [activeTab, setActiveTab] = useState('queries') // 'queries' | 'memories'
  const [records, setRecords] = useState([])
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [errorStatus, setErrorStatus] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [search, setSearch] = useState('')
  const [clearing, setClearing] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const getHeaders = (tokenOverride) => {
    const headers = {}
    const token = tokenOverride ?? session?.access_token
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }

  // Throw an Error carrying HTTP status + backend {"error"} message when present.
  const throwForStatus = async (r) => {
    if (r.ok) return r
    let serverMsg = ''
    try {
      const body = await r.clone().json()
      if (body && typeof body.error === 'string') serverMsg = body.error
    } catch {
      // non-JSON error body — fall through to status message
    }
    const err = new Error(serverMsg || `Server responded ${r.status}`)
    err.status = r.status
    throw err
  }

  const fail = (err) => {
    const status = err?.status ?? (err instanceof TypeError ? 'network' : null)
    setErrorStatus(status)
    if (status === 401) {
      setError(err.message && !err.message.startsWith('Server responded')
        ? err.message
        : 'Your login session was rejected by the backend (401 Unauthorized).')
    } else if (status === 'network' || err instanceof TypeError) {
      setError('Cannot reach the backend server.')
    } else {
      setError(err.message)
    }
    setLoading(false)
  }

  // On 401, try one silent Supabase refresh before surfacing the error.
  // App.jsx's onAuthStateChange will pick up the refreshed session and refetch.
  const tryRefreshAndRetry = async (retryFn) => {
    try {
      const { data, error: refreshErr } = await supabase.auth.refreshSession()
      if (!refreshErr && data?.session?.access_token) {
        retryFn(data.session.access_token)
        return true
      }
    } catch {
      // ignore — fall through to showing the auth error
    }
    return false
  }

  const fetchHistory = (tokenOverride, _retried = false) => {
    setLoading(true)
    setError(null)
    setErrorStatus(null)
    fetch(HISTORY_URL, { headers: getHeaders(tokenOverride) })
      .then(throwForStatus)
      .then(r => r.json())
      .then(data => { setRecords(data); setLoading(false) })
      .catch(async (err) => {
        if (err?.status === 401 && !_retried && session) {
          const retried = await tryRefreshAndRetry((t) => fetchHistory(t, true))
          if (retried) return
        }
        fail(err)
      })
  }

  const fetchMemories = (tokenOverride, _retried = false) => {
    setLoading(true)
    setError(null)
    setErrorStatus(null)
    fetch(MEMORIES_URL, { headers: getHeaders(tokenOverride) })
      .then(throwForStatus)
      .then(r => r.json())
      .then(data => { setMemories(data); setLoading(false) })
      .catch(async (err) => {
        if (err?.status === 401 && !_retried && session) {
          const retried = await tryRefreshAndRetry((t) => fetchMemories(t, true))
          if (retried) return
        }
        fail(err)
      })
  }

  const handleSignInAgain = async () => {
    setSigningOut(true)
    try {
      await supabase.auth.signOut()
    } finally {
      setSigningOut(false)
      onClose()
    }
  }

  const clearMemories = () => {
    if (!confirm('Are you sure you want to clear all semantic RAG memories for your user account?')) return
    setClearing(true)
    fetch(MEMORIES_URL, { method: 'DELETE', headers: getHeaders() })
      .then(throwForStatus)
      .then(r => r.json())
      .then(() => { setMemories([]); setClearing(false) })
      .catch(async (err) => {
        setClearing(false)
        if (err?.status === 401) {
          alert('Session expired — please sign in again, then retry clearing memories.')
        } else {
          alert('Failed to clear memories: ' + err.message)
        }
      })
  }

  useEffect(() => {
    if (activeTab === 'queries') {
      fetchHistory()
    } else {
      fetchMemories()
    }
  }, [activeTab, session])

  const filteredRecords = records.filter(r =>
    !search ||
    r.prompt.toLowerCase().includes(search.toLowerCase()) ||
    r.answer.toLowerCase().includes(search.toLowerCase())
  )

  const filteredMemories = memories.filter(m =>
    !search || m.content.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="history-header">
          <div className="history-title-row">
            <Database size={18} className="history-icon" />
            <h2 className="history-title">Data & Memory Hub</h2>
          </div>
          <button className="history-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Tab Switcher */}
        <div className="history-tabs-bar">
          <button
            type="button"
            className={`history-tab-btn ${activeTab === 'queries' ? 'active' : ''}`}
            onClick={() => { setActiveTab('queries'); setExpanded(null); setSearch('') }}
          >
            <Database size={14} />
            <span>Cloud History ({records.length})</span>
          </button>

          <button
            type="button"
            className={`history-tab-btn ${activeTab === 'memories' ? 'active' : ''}`}
            onClick={() => { setActiveTab('memories'); setExpanded(null); setSearch('') }}
          >
            <Brain size={14} />
            <span>RAG Vector Memories ({memories.length})</span>
          </button>
        </div>

        {/* Search & Actions Bar */}
        <div className="history-search-wrap">
          <Search size={15} className="history-search-icon" />
          <input
            className="history-search"
            placeholder={activeTab === 'queries' ? "Search prompts & answers…" : "Search vector embeddings & context…"}
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button className="history-search-clear" onClick={() => setSearch('')}><X size={14} /></button>
          )}

          {activeTab === 'memories' && memories.length > 0 && (
            <button
              className="history-clear-memories-btn"
              onClick={clearMemories}
              disabled={clearing}
              title="Clear stored vector memories"
            >
              <Trash2 size={13} />
              <span>Clear</span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="history-body">
          {loading && (
            <div className="history-state">
              <div className="history-spinner" />
              <p>Loading {activeTab === 'queries' ? 'queries' : 'vector memories'} from database…</p>
            </div>
          )}

          {error && (
            <div className="history-state history-state-error">
              <AlertTriangle size={22} />
              <p>{errorStatus === 401 ? 'Session expired — please sign in again' : error}</p>
              {errorStatus === 401 ? (
                <>
                  <p className="history-state-hint">
                    The backend ({API_URL}) rejected your login token. Your session may have
                    expired, or the frontend/backend Supabase projects do not match.
                  </p>
                  <div className="history-error-actions">
                    <button
                      className="history-signin-btn"
                      onClick={handleSignInAgain}
                      disabled={signingOut}
                    >
                      <LogIn size={14} /> {signingOut ? 'Signing out…' : 'Sign in again'}
                    </button>
                    <button className="history-retry-btn" onClick={activeTab === 'queries' ? () => fetchHistory() : () => fetchMemories()}>
                      <RotateCw size={14} /> Retry
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="history-state-hint">Make sure the backend server ({API_URL}) is reachable</p>
                  <button className="history-retry-btn" onClick={activeTab === 'queries' ? () => fetchHistory() : () => fetchMemories()}>
                    <RotateCw size={14} /> Retry
                  </button>
                </>
              )}
            </div>
          )}

          {/* QUERIES TAB */}
          {!loading && !error && activeTab === 'queries' && filteredRecords.length === 0 && (
            <div className="history-state">
              <Search size={28} style={{ opacity: 0.6 }} />
              <p>{search ? 'No results for that search.' : 'No queries saved yet.'}</p>
            </div>
          )}

          {!loading && !error && activeTab === 'queries' && filteredRecords.map(record => {
            const ProviderIcon = MODEL_ICONS[record.provider] ?? Sparkles
            return (
              <div
                key={record.id}
                className={`history-item ${expanded === record.id ? 'expanded' : ''}`}
                onClick={() => setExpanded(expanded === record.id ? null : record.id)}
              >
                <div className="history-item-header">
                  <ProviderIcon
                    size={14}
                    style={{ color: PROVIDER_COLORS[record.provider] ?? '#888', flexShrink: 0 }}
                    title={record.provider}
                  />
                  <p className="history-prompt">{record.prompt}</p>
                  <span className="history-time">{timeAgo(record.created_at)}</span>
                  <span className="history-chevron">
                    {expanded === record.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </div>

                {expanded === record.id && (
                  <div className="history-answer">
                    <div className="history-answer-label">
                      <span
                        className="history-answer-provider"
                        style={{ color: PROVIDER_COLORS[record.provider] ?? '#888' }}
                      >
                        {record.provider}
                      </span>
                      <span className="history-answer-date">
                        {new Date(record.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="history-answer-text">
                      <ReactMarkdown>{record.answer}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* MEMORIES TAB */}
          {!loading && !error && activeTab === 'memories' && filteredMemories.length === 0 && (
            <div className="history-state">
              <Brain size={32} style={{ opacity: 0.5, color: '#c084fc' }} />
              <p>{search ? 'No matching memories found.' : 'No vector memories stored yet.'}</p>
              <p className="history-state-hint">As you chat with Nexus, prompts and key answers are automatically converted into 1536-dim embeddings for semantic retrieval (RAG).</p>
            </div>
          )}

          {!loading && !error && activeTab === 'memories' && filteredMemories.map(mem => (
            <div
              key={mem.id}
              className={`history-item memory-item ${expanded === mem.id ? 'expanded' : ''}`}
              onClick={() => setExpanded(expanded === mem.id ? null : mem.id)}
            >
              <div className="history-item-header">
                <Brain size={14} style={{ color: '#c084fc', flexShrink: 0 }} />
                <p className="history-prompt">{mem.content.slice(0, 90)}…</p>
                <span className="history-time">{timeAgo(mem.created_at)}</span>
                <span className="history-chevron">
                  {expanded === mem.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </div>

              {expanded === mem.id && (
                <div className="history-answer">
                  <div className="history-answer-label">
                    <span className="history-answer-provider" style={{ color: '#c084fc' }}>
                      1536d Vector Embedding (pgvector / SQLite)
                    </span>
                    <span className="history-answer-date">
                      {new Date(mem.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="history-answer-text">
                    <ReactMarkdown>{mem.content}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
