import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { Database, Search, X, AlertTriangle, ChevronUp, ChevronDown, Sparkles, Zap, Wind, Bot, Gem, Layers } from 'lucide-react'
import './HistoryPanel.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

const HISTORY_URL = `${API_URL}/history`

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

export default function HistoryPanel({ onClose }) {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch(HISTORY_URL)
      .then(r => {
        if (!r.ok) throw new Error(`Server responded ${r.status}`)
        return r.json()
      })
      .then(data => { setRecords(data); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  const filtered = records.filter(r =>
    !search ||
    r.prompt.toLowerCase().includes(search.toLowerCase()) ||
    r.answer.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="history-header">
          <div className="history-title-row">
            <Database size={18} className="history-icon" />
            <h2 className="history-title">Cloud History</h2>
            <span className="history-count">{records.length} queries</span>
          </div>
          <button className="history-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Search */}
        <div className="history-search-wrap">
          <Search size={15} className="history-search-icon" />
          <input
            className="history-search"
            placeholder="Search prompts and answers…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button className="history-search-clear" onClick={() => setSearch('')}><X size={14} /></button>
          )}
        </div>

        {/* Body */}
        <div className="history-body">
          {loading && (
            <div className="history-state">
              <div className="history-spinner" />
              <p>Loading from database…</p>
            </div>
          )}

          {error && (
            <div className="history-state history-state-error">
              <AlertTriangle size={22} />
              <p>{error}</p>
              <p className="history-state-hint">Make sure the Go server is running on localhost:8080</p>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="history-state">
              <Search size={28} style={{ opacity: 0.6 }} />
              <p>{search ? 'No results for that search.' : 'No queries saved yet.'}</p>
            </div>
          )}

          {!loading && !error && filtered.map(record => {
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
        </div>
      </div>
    </div>
  )
}
