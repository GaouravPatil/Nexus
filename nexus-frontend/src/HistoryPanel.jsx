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
  Trash2
} from 'lucide-react'
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
  const [expanded, setExpanded] = useState(null)
  const [search, setSearch] = useState('')
  const [clearing, setClearing] = useState(false)

  const getHeaders = () => {
    const headers = {}
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`
    }
    return headers
  }

  const fetchHistory = () => {
    setLoading(true)
    setError(null)
    fetch(HISTORY_URL, { headers: getHeaders() })
      .then(r => {
        if (!r.ok) throw new Error(`Server responded ${r.status}`)
        return r.json()
      })
      .then(data => { setRecords(data); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }

  const fetchMemories = () => {
    setLoading(true)
    setError(null)
    fetch(MEMORIES_URL, { headers: getHeaders() })
      .then(r => {
        if (!r.ok) throw new Error(`Server responded ${r.status}`)
        return r.json()
      })
      .then(data => { setMemories(data); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }

  const clearMemories = () => {
    if (!confirm('Are you sure you want to clear all semantic RAG memories for your user account?')) return
    setClearing(true)
    fetch(MEMORIES_URL, { method: 'DELETE', headers: getHeaders() })
      .then(r => r.json())
      .then(() => { setMemories([]); setClearing(false) })
      .catch(err => { alert('Failed to clear memories: ' + err.message); setClearing(false) })
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
              <p>{error}</p>
              <p className="history-state-hint">Make sure the backend server ({API_URL}) is reachable</p>
              <button className="history-retry-btn" onClick={activeTab === 'queries' ? fetchHistory : fetchMemories}>
                <RotateCw size={14} /> Retry
              </button>
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
