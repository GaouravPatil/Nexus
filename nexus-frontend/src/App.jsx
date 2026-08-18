import { useState, useRef, useEffect, Component } from 'react'
import ReactMarkdown from 'react-markdown'
import BlurText from './BlurText'
import SideRays from './SideRays'
import BorderGlow from './BorderGlow'
import AuthModal from './AuthModal.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import { supabase, isSupabaseConfigured } from './supabaseClient.js'
import './App.css'

// Error boundary to prevent ReactMarkdown crashes from taking down the whole page
class MarkdownBoundary extends Component {
  constructor(props) { super(props); this.state = { error: false } }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) return <span style={{ color: 'var(--ink-soft)', fontStyle: 'italic' }}>[render error]</span>
    return this.props.children
  }
}

const API_URL = import.meta.env.VITE_API_URL

const STREAM_URL = `${API_URL}/stream`
const SUMMARIZE_URL = `${API_URL}/summarize`

// Provider → brand colour map (module-level so it never re-creates)
const PROVIDER_COLORS = {
  groq: '#D97757',
  mistral: '#6E8EF0',
  chatgpt: '#10a37f',
  gemini: '#E8A820',
  ensemble: '#c084fc',
  auto: '#888',
}

// ── Dynamic time-of-day greeting (Claude style) ──
function getDynamicGreeting(user) {
  const hour = new Date().getHours()
  let timeOfDay = 'day'
  if (hour >= 5 && hour < 12) timeOfDay = 'morning'
  else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon'
  else if (hour >= 17 && hour < 22) timeOfDay = 'evening'
  else timeOfDay = 'night'

  let name = ''
  if (user?.email) {
    name = user.email.split('@')[0]
    name = name.charAt(0).toUpperCase() + name.slice(1)
  } else if (user?.user_metadata?.full_name) {
    name = user.user_metadata.full_name.split(' ')[0]
  }

  const salutation = timeOfDay === 'night' ? 'Late night coding' : `Good ${timeOfDay}`
  return name ? `${salutation}, ${name}` : `${salutation}, Dev`
}

const STARTER_PROMPTS = [
  { icon: '⚡', label: 'Debug & Fix', text: 'Help me debug an issue in my code architecture' },
  { icon: '🚀', label: 'System Design', text: 'Explain how to design a high-throughput SSE microservice in Go' },
  { icon: '🧠', label: 'Brainstorm Ideas', text: 'Give me 5 innovative features for an AI assistant web application' },
  { icon: '📝', label: 'Summarize Text', text: 'Summarize the core architectural benefits of cross-model context handoff' },
]

// Each conversation tracks:
//   messages  – display messages (role: user | assistant | error | handoff)
//   history   – OpenAI-style [{role, content}] for the backend
//   provider  – active provider name
//   handoffs  – model-switch event log
const makeConv = () => ({
  id: Date.now(),
  title: 'New Chat',
  provider: 'auto',
  messages: [],
  history: [],
  handoffs: [],
})

// ─── Composer component (MUST be module-level, not nested inside App) ──────────
// Defining it inside App causes it to be re-created on every render, which
// unmounts the <textarea> element after each keystroke — the root cause of the
// "only first character typed" bug.
function Composer({ prompt, onPromptChange, onSubmit, onKeyDown, onProviderChange, provider, loading, switchingModel, isEmpty }) {
  return (
    <div className={`composer-glow-wrap${isEmpty ? ' landing-composer-wrap' : ''}`}>
      <BorderGlow
        borderRadius={22}
        backgroundColor="#131318"
        glowColor="20 70 60"
        colors={['#D97757', '#6E8EF0', '#c084fc']}
        glowIntensity={1.4}
        glowRadius={30}
        edgeSensitivity={18}
        coneSpread={30}
        fillOpacity={0.35}
        animated={isEmpty}
      >
        <form className="composer" onSubmit={onSubmit}>
          <textarea
            value={prompt}
            onChange={onPromptChange}
            onKeyDown={onKeyDown}
            placeholder="Message Nexus…"
            rows={1}
            disabled={switchingModel}
            autoFocus
          />
          <div className="composer-actions">
            <select
              className="provider-select-inline"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value)}
              title="Choose AI provider"
              disabled={switchingModel}
            >
              <option value="auto">Auto</option>
              <option value="groq">Groq</option>
              <option value="mistral">Mistral</option>
              <option value="chatgpt">ChatGPT</option>
              <option value="gemini">Gemini</option>
              <option value="ensemble">Ensemble</option>
            </select>
            <button
              type="submit"
              disabled={loading || switchingModel || !prompt.trim()}
              aria-label="Send"
            >
              {loading ? '…' : '↑'}
            </button>
          </div>
        </form>
      </BorderGlow>
    </div>
  )
}

function App() {
  const [conversations, setConversations] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus-convs')
      const parsed = saved ? JSON.parse(saved) : null
      return parsed && parsed.length > 0 ? parsed : [makeConv()]
    } catch {
      return [makeConv()]
    }
  })
  const [currentId, setCurrentId] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus-convs')
      const parsed = saved ? JSON.parse(saved) : null
      return parsed && parsed.length > 0 ? parsed[0].id : null
    } catch {
      return null
    }
  })
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('auto')
  const [loading, setLoading] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768
    }
    return true
  })
  const [historyOpen, setHistoryOpen] = useState(false)
  // Auth state
  const [user, setUser] = useState(null)         // Supabase user object or null
  const [authReady, setAuthReady] = useState(false) // false = show auth modal
  const bottomRef = useRef(null)

  const currentConv = conversations.find((c) => c.id === currentId) ?? conversations[0]
  const messages = currentConv?.messages ?? []
  const isEmpty = messages.length === 0

  // ── On mount: restore Supabase session (if env vars are set) ──
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthReady(true)
      return
    }
    supabase.auth.getSession()
      .then(({ data }) => {
        setUser(data?.session?.user ?? null)
      })
      .catch((err) => {
        console.warn('Supabase getSession failed:', err)
      })
      .finally(() => {
        setAuthReady(true)
      })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => listener?.subscription?.unsubscribe()
  }, [])


  useEffect(() => {
    localStorage.setItem('nexus-convs', JSON.stringify(conversations))
  }, [conversations])

  useEffect(() => {
    if (!currentId && conversations.length > 0) {
      setCurrentId(conversations[0].id)
    }
  }, [conversations, currentId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, switchingModel])

  // Close contact dropdown on outside click
  useEffect(() => {
    if (!contactOpen) return
    const close = () => setContactOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contactOpen])

  function updateConv(id, updater) {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)))
  }

  function startNewChat() {
    const conv = makeConv()
    setConversations((prev) => [conv, ...prev])
    setCurrentId(conv.id)
    setPrompt('')
    setProvider('auto')  // FIX: reset provider selector when starting new chat
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }

  function selectConv(id) {
    setCurrentId(id)
    // Sync the provider selector to whatever the selected conv is using
    const conv = conversations.find((c) => c.id === id)
    if (conv) setProvider(conv.provider ?? 'auto')
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }

  function deleteConv(id, e) {
    e.stopPropagation()
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id)
      if (filtered.length === 0) {
        const fresh = makeConv()
        setCurrentId(fresh.id)
        setProvider('auto')
        return [fresh]
      }
      if (currentId === id) {
        setCurrentId(filtered[0].id)
        setProvider(filtered[0].provider ?? 'auto')
      }
      return filtered
    })
  }

  // ─── Provider switch handler ──────────────────────────────────────────────
  async function handleProviderChange(newProvider) {
    setProvider(newProvider)

    const conv = currentConv
    // Only trigger handoff if: there are existing messages AND the provider actually changed
    const currentProvider = conv?.provider ?? 'auto'
    if (!conv || conv.messages.length === 0 || currentProvider === newProvider) return

    setSwitchingModel(true)

    // Inject a "switching…" notice in the chat
    updateConv(conv.id, (c) => ({
      ...c,
      messages: [
        ...c.messages,
        {
          role: 'handoff',
          text: `Switching from **${currentProvider}** → **${newProvider}**… analysing chat history`,
          fromProvider: currentProvider,
          toProvider: newProvider,
        },
      ],
    }))

    try {
      const res = await fetch(SUMMARIZE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: conv.history ?? [],
          from_provider: currentProvider,
          to_provider: newProvider,
        }),
      })

      let systemBrief = null
      if (res.ok) {
        const data = await res.json()
        systemBrief = data.summary
      }

      updateConv(conv.id, (c) => {
        // Inject system brief: replace any existing system message so it doesn't grow unboundedly
        const baseHistory = c.history.filter((h) => h.role !== 'system')
        const newHistory = systemBrief
          ? [{ role: 'system', content: systemBrief }, ...baseHistory]
          : baseHistory

        const updatedMessages = c.messages.map((m) =>
          m.role === 'handoff' && m.toProvider === newProvider && !m.done
            ? {
              ...m,
              text: `Switched to **${newProvider}**. ${systemBrief ? 'Context absorbed ✓' : 'Switching without context brief.'}`,
              done: true,
            }
            : m
        )

        return {
          ...c,
          provider: newProvider,
          history: newHistory,
          messages: updatedMessages,
          handoffs: [
            ...(c.handoffs ?? []),
            { fromProvider: currentProvider, toProvider: newProvider, summary: systemBrief },
          ],
        }
      })
    } catch (err) {
      console.warn('summarize failed:', err)
      updateConv(conv.id, (c) => ({
        ...c,
        provider: newProvider,
        messages: c.messages.map((m) =>
          m.role === 'handoff' && m.toProvider === newProvider && !m.done
            ? { ...m, text: `Switched to **${newProvider}**.`, done: true }
            : m
        ),
      }))
    } finally {
      setSwitchingModel(false)
    }
  }

  // ─── Submit handler (SSE streaming) ─────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    const text = prompt.trim()
    if (!text || loading || switchingModel) return

    const targetId = currentConv?.id ?? currentId
    const convSnapshot = conversations.find((c) => c.id === targetId) ?? currentConv
    const currentHistory = convSnapshot?.history ?? []

    // Add the user message optimistically
    updateConv(targetId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? text.slice(0, 42) : c.title,
      provider: provider,
      messages: [...c.messages, { role: 'user', text }],
      history: [...(c.history ?? []), { role: 'user', content: text }],
    }))
    setPrompt('')
    setLoading(true)

    const historyToSend = [...currentHistory, { role: 'user', content: text }]

    // Placeholder streaming message — we'll append tokens into it
    const streamingMsgId = Date.now()
    updateConv(targetId, (c) => ({
      ...c,
      messages: [...c.messages, { role: 'assistant', text: '', provider: provider, streaming: true, _id: streamingMsgId }],
    }))

    try {
      const controller = new AbortController()
      const res = await fetch(STREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: historyToSend, provider }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText.trim() || `Request failed (${res.status})`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let activeProvider = provider
      let rawAnswers = null
      let fullText = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Process all complete SSE lines in buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete last line

        let currentEvent = null
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim()
            if (currentEvent === 'provider') {
              activeProvider = JSON.parse(raw)
              // Update placeholder message with resolved provider
              updateConv(targetId, (c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m._id === streamingMsgId ? { ...m, provider: activeProvider } : m
                ),
              }))
            } else if (currentEvent === 'raw_answers') {
              rawAnswers = JSON.parse(raw)
            } else if (currentEvent === 'error') {
              throw new Error(JSON.parse(raw))
            } else if (currentEvent === 'done') {
              // Finalise: remove streaming flag
              updateConv(targetId, (c) => ({
                ...c,
                history: [...(c.history ?? []), { role: 'assistant', content: fullText }],
                messages: c.messages.map((m) =>
                  m._id === streamingMsgId
                    ? { ...m, streaming: false, rawAnswers }
                    : m
                ),
              }))
            } else {
              // Regular token
              const token = JSON.parse(raw)
              fullText += token
              updateConv(targetId, (c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m._id === streamingMsgId ? { ...m, text: m.text + token } : m
                ),
              }))
            }
            currentEvent = null
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      const isNetworkErr = err instanceof TypeError && err.message === 'Failed to fetch'
      const displayMsg = isNetworkErr
        ? '⚠️ Cannot reach the Nexus backend (localhost:8080). Make sure the Go server is running.'
        : err.message
      // Replace the streaming placeholder with an error message
      updateConv(targetId, (c) => ({
        ...c,
        messages: c.messages
          .filter((m) => m._id !== streamingMsgId)
          .concat({ role: 'error', text: displayMsg }),
      }))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const composerProps = {
    prompt,
    onPromptChange: (e) => setPrompt(e.target.value),
    onSubmit: handleSubmit,
    onKeyDown: handleKeyDown,
    onProviderChange: handleProviderChange,
    provider,
    loading,
    switchingModel,
    isEmpty,
  }

  return (
    <div className="page">
      {/* Show auth modal until the user is resolved */}
      {!authReady && (
        <AuthModal onAuth={(u) => { setUser(u); setAuthReady(true) }} />
      )}
      <SideRays
        speed={2.2}
        rayColor1="#D97757"
        rayColor2="#6E8EF0"
        intensity={1.6}
        spread={1.8}
        origin="top-right"
        tilt={0}
        saturation={1.3}
        blend={0.7}
        falloff={1.7}
        opacity={0.9}
        className="page-rays"
      />

      {/* ── Sidebar Backdrop (mobile) ── */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        <div className="sidebar-header">
          <div className="brand">
            <svg
              className="brand-logo"
              viewBox="0 0 56 56"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <ellipse cx="28" cy="17" rx="7" ry="17" fill="#D97757" transform="rotate(0 28 28)" />
              <ellipse cx="28" cy="17" rx="7" ry="17" fill="#E8A820" transform="rotate(120 28 28)" />
              <ellipse cx="28" cy="17" rx="7" ry="17" fill="#6E8EF0" transform="rotate(240 28 28)" />
              <circle cx="28" cy="28" r="4.5" fill="#F2F1EE" />
            </svg>
            <span className="brand-name">Nexus</span>
          </div>
          <button className="new-chat-btn" onClick={startNewChat} title="New chat">
            ✎
          </button>
        </div>

        <p className="sidebar-section-label">Recents</p>

        <div className="sidebar-list">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`sidebar-item ${conv.id === currentId ? 'active' : ''}`}
              onClick={() => selectConv(conv.id)}
            >
              <span className="sidebar-item-icon">💬</span>
              <span className="sidebar-item-title">{conv.title}</span>
              {conv.provider && conv.provider !== 'auto' && (
                <span
                  className="sidebar-provider-dot"
                  style={{ backgroundColor: PROVIDER_COLORS[conv.provider] ?? '#888' }}
                  title={conv.provider}
                />
              )}
              <button
                className="sidebar-delete"
                onClick={(e) => deleteConv(conv.id, e)}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main content area ── */}
      <div className="main-area">
        <header className="topbar">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle sidebar"
          >
            ☰
          </button>
          <div className="topbar-actions">
            {/* User badge / sign-out */}
            {user ? (
              <div className="topbar-user">
                <span className="topbar-user-badge" title={user.email}>
                  <span className="topbar-user-icon">👤</span>
                  <span className="topbar-user-email">{user.email}</span>
                </span>
                <button
                  className="signout-btn"
                  title="Sign out"
                  onClick={async () => {
                    await supabase.auth.signOut()
                    setUser(null)
                  }}
                >
                  <span className="topbar-btn-text">Sign out</span>
                </button>
              </div>
            ) : (
              <button className="docs-btn" onClick={() => setAuthReady(false)} title="Sign in">
                <span className="docs-btn-icon">👤</span>
                <span className="topbar-btn-text">Sign in</span>
              </button>
            )}
            {/* Cloud history panel */}
            <button className="docs-btn" onClick={() => setHistoryOpen(true)} title="History">
              <span className="docs-btn-icon">🗄️</span>
              <span className="topbar-btn-text">History</span>
            </button>
            <div className="topbar-dropdown-wrap">
              <button className="docs-btn" onClick={(e) => { e.stopPropagation(); setContactOpen((v) => !v); }} title="Contact">
                <span className="docs-btn-icon">✉</span>
                <span className="topbar-btn-text">Contact</span>
              </button>
              {contactOpen && (
                <div className="topbar-dropdown" onClick={(e) => e.stopPropagation()}>
                  <p className="topbar-dropdown-heading">Get in touch</p>
                  <ul className="topbar-contact-list">
                    <li>
                      <span className="contact-icon">✉</span>
                      <a href="mailto:patilgaourav304@gmail.com" className="contact-link">
                        patilgaourav304@gmail.com
                      </a>
                    </li>
                    <li>
                      <span className="contact-icon">📞</span>
                      <a href="tel:+919834892067" className="contact-link">
                        +91 98348 92067
                      </a>
                    </li>
                    <li>
                      <span className="contact-icon">🕐</span>
                      <span className="contact-available">Available 24 / 7</span>
                    </li>
                  </ul>
                </div>
              )}
            </div>
            <a
              href="https://github.com/GaouravPatil/Nexus#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="docs-btn"
              title="View GitHub Documentation"
            >
              <span className="docs-btn-icon">📖</span>
              <span className="topbar-btn-text">Docs</span>
            </a>
          </div>
        </header>

        <div className="shell">
          {isEmpty ? (
            /* ── Landing: dynamic greeting + composer + starter chips ── */
            <div className="landing">
              <div className="hero">
                <BlurText
                  key={user?.email ?? 'dev'}
                  text={getDynamicGreeting(user)}
                  animateBy="words"
                  direction="top"
                  className="hero-line hero-minimal"
                />
                <p className="hero-subtext">
                  What would you like to build or explore today?
                </p>
              </div>
              <Composer {...composerProps} />
              <div className="starter-chips">
                {STARTER_PROMPTS.map((chip, idx) => (
                  <button
                    key={idx}
                    className="starter-chip"
                    onClick={() => setPrompt(chip.text)}
                  >
                    <span className="starter-chip-icon">{chip.icon}</span>
                    <span className="starter-chip-label">{chip.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* ── Chat mode: messages + bottom composer ── */
            <>
              <main className="conversation">
                <div className="messages">
                  {messages.map((m, i) => {
                    // ── Handoff divider ──
                    if (m.role === 'handoff') {
                      return (
                        <div key={i} className="handoff-notice">
                          <div className="handoff-line" />
                          <div className="handoff-badge">
                            <span
                              className="handoff-dot"
                              style={{ backgroundColor: PROVIDER_COLORS[m.fromProvider] ?? '#888' }}
                            />
                            <span className="handoff-label">
                              <ReactMarkdown>{m.text}</ReactMarkdown>
                            </span>
                            <span
                              className="handoff-dot"
                              style={{ backgroundColor: PROVIDER_COLORS[m.toProvider] ?? '#888' }}
                            />
                          </div>
                          <div className="handoff-line" />
                        </div>
                      )
                    }

                    return (
                      <div key={i} className={`message ${m.role}`}>
                        {m.role === 'assistant' && (
                          <div
                            className="provider-tag"
                            style={{
                              borderColor: PROVIDER_COLORS[m.provider] ?? '#555',
                              color: PROVIDER_COLORS[m.provider] ?? 'var(--ink-soft)',
                            }}
                          >
                            {m.provider}
                          </div>
                        )}
                        <div className="bubble">
                          {m.role === 'assistant' ? (
                            <MarkdownBoundary>
                              <div className="md-content">
                                <ReactMarkdown>{String(m.text ?? '')}</ReactMarkdown>
                                {m.streaming && <span className="stream-cursor" />}
                              </div>
                            </MarkdownBoundary>
                          ) : (
                            m.text
                          )}
                        </div>

                        {m.rawAnswers && (
                          <div className="raw-answers">
                            {Object.entries(m.rawAnswers).map(([name, answer]) => (
                              <details key={name}>
                                <summary>{name}</summary>
                                <p>{answer}</p>
                              </details>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {switchingModel && (
                    <div className="message assistant">
                      <div className="provider-tag" style={{ borderColor: '#E8A820', color: '#E8A820' }}>
                        analysing…
                      </div>
                      <div className="bubble typing">
                        <span></span><span></span><span></span>
                      </div>
                    </div>
                  )}

                  {loading && !messages.some((m) => m.streaming) && (
                    <div className="message assistant">
                      <div className="provider-tag">connecting…</div>
                      <div className="bubble typing">
                        <span></span><span></span><span></span>
                      </div>
                    </div>
                  )}

                  <div ref={bottomRef} />
                </div>
              </main>

              <Composer {...composerProps} />
            </>
          )}
        </div>
      </div>

      {/* ── History Panel ── */}
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}

export default App