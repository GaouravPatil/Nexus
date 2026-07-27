import { useState, useRef, useEffect } from 'react'
import BlurText from './BlurText'
import SideRays from './SideRays'
import './App.css'

const API_URL = 'http://localhost:8080/query'

const makeConv = () => ({ id: Date.now(), title: 'New Chat', messages: [] })

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
  const [greetStep, setGreetStep] = useState(0)
  const [docsOpen, setDocsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const bottomRef = useRef(null)

  const currentConv = conversations.find((c) => c.id === currentId) ?? conversations[0]
  const messages = currentConv?.messages ?? []
  const isEmpty = messages.length === 0

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
  }, [messages, loading])

  function updateConv(id, updater) {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)))
  }

  function startNewChat() {
    const conv = makeConv()
    setConversations((prev) => [conv, ...prev])
    setCurrentId(conv.id)
    setGreetStep(0)
    setPrompt('')
  }

  function selectConv(id) {
    setCurrentId(id)
    setGreetStep(3)
  }

  function deleteConv(id, e) {
    e.stopPropagation()
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id)
      if (filtered.length === 0) {
        const fresh = makeConv()
        setCurrentId(fresh.id)
        return [fresh]
      }
      if (currentId === id) setCurrentId(filtered[0].id)
      return filtered
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const text = prompt.trim()
    if (!text || loading) return

    const targetId = currentConv?.id ?? currentId

    updateConv(targetId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? text.slice(0, 42) : c.title,
      messages: [...c.messages, { role: 'user', text }],
    }))
    setPrompt('')
    setLoading(true)

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, provider }),
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || `Request failed (${res.status})`)
      }

      const data = await res.json()
      updateConv(targetId, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: 'assistant',
            text: data.answer,
            provider: data.provider,
            rawAnswers: data.raw_answers,
          },
        ],
      }))
    } catch (err) {
      updateConv(targetId, (c) => ({
        ...c,
        messages: [...c.messages, { role: 'error', text: err.message }],
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

  return (
    <div className="page">
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

      {/* ── Sidebar ── */}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-mark">✦</span>
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
          <button className="docs-btn" onClick={() => setDocsOpen(true)}>
            <span className="docs-btn-icon">📖</span> Docs
          </button>
        </header>

        <div className="shell">
          {isEmpty ? (
            /* ── Landing: greeting + composer centered ── */
            <div className="landing">
              <div className="hero">
                <div className="hero-badge">
                  <span className="hero-badge-dot">NEW</span>
                  Multi-model orchestration
                </div>

                <BlurText
                  text="Welcome Garry,"
                  animateBy="words"
                  direction="top"
                  className="hero-line hero-line-1"
                  onAnimationComplete={() => setGreetStep(1)}
                />
                {greetStep >= 1 && (
                  <BlurText
                    text="Wanna do more?"
                    animateBy="words"
                    direction="top"
                    delay={80}
                    className="hero-line hero-line-2"
                    onAnimationComplete={() => setGreetStep(2)}
                  />
                )}
                {greetStep >= 2 && (
                  <BlurText
                    text="Let's go deep."
                    animateBy="words"
                    direction="top"
                    delay={80}
                    className="hero-line hero-line-3"
                  />
                )}

                <p className="hero-subtext">
                  One prompt, routed across Groq and Mistral — or merged into a single,
                  cross-validated answer.
                </p>
              </div>

              {/* Inlined composer — do NOT extract to a sub-component inside App */}
              <form className="composer landing-composer" onSubmit={handleSubmit}>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message Nexus..."
                  rows={1}
                />
                <div className="composer-actions">
                  <select
                    className="provider-select-inline"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    title="Choose AI provider"
                  >
                    <option value="auto">Auto</option>
                    <option value="groq">Groq</option>
                    <option value="mistral">Mistral</option>
                    <option value="ensemble">Ensemble</option>
                  </select>
                  <button
                    type="submit"
                    disabled={loading || !prompt.trim()}
                    aria-label="Send"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* ── Chat mode: messages + bottom composer ── */
            <>
              <main className="conversation">
                <div className="messages">
                  {messages.map((m, i) => (
                    <div key={i} className={`message ${m.role}`}>
                      {m.role === 'assistant' && (
                        <div className="provider-tag">{m.provider}</div>
                      )}
                      <div className="bubble">{m.text}</div>

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
                  ))}

                  {loading && (
                    <div className="message assistant">
                      <div className="provider-tag">thinking…</div>
                      <div className="bubble typing">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>
                  )}

                  <div ref={bottomRef} />
                </div>
              </main>

              {/* Inlined composer — do NOT extract to a sub-component inside App */}
              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message Nexus..."
                  rows={1}
                />
                <div className="composer-actions">
                  <select
                    className="provider-select-inline"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    title="Choose AI provider"
                  >
                    <option value="auto">Auto</option>
                    <option value="groq">Groq</option>
                    <option value="mistral">Mistral</option>
                    <option value="ensemble">Ensemble</option>
                  </select>
                  <button
                    type="submit"
                    disabled={loading || !prompt.trim()}
                    aria-label="Send"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>

      {/* ── Docs Modal ── */}
      {docsOpen && (
        <div className="docs-overlay" onClick={() => setDocsOpen(false)}>
          <div className="docs-panel" onClick={(e) => e.stopPropagation()}>
            <div className="docs-panel-header">
              <h2 className="docs-title">How to use Nexus</h2>
              <button className="docs-close" onClick={() => setDocsOpen(false)}>
                ×
              </button>
            </div>

            <div className="docs-body">
              <div className="docs-section">
                <h3>🚀 Getting started</h3>
                <p>
                  Type any question or prompt into the message box and press{' '}
                  <kbd>Enter</kbd> (or click ↑) to send.
                </p>
              </div>

              <div className="docs-section">
                <h3>🤖 Choosing a provider</h3>
                <p>
                  Use the dropdown next to the send button to pick which AI powers
                  your response:
                </p>
                <ul>
                  <li>
                    <strong>Auto</strong> — Nexus picks the fastest available model.
                  </li>
                  <li>
                    <strong>Groq</strong> — Ultra-fast inference via Groq's LPU hardware.
                  </li>
                  <li>
                    <strong>Mistral</strong> — Mistral AI's flagship models.
                  </li>
                  <li>
                    <strong>Ensemble</strong> — Queries both Groq & Mistral in parallel
                    and synthesizes a cross-validated answer. Expand each raw response
                    below the answer to compare.
                  </li>
                </ul>
              </div>

              <div className="docs-section">
                <h3>💬 Chat history</h3>
                <p>
                  Every conversation is saved in your browser. Click any item in the
                  left sidebar to revisit it. Use <strong>✎</strong> to start a new
                  conversation. Delete any chat with the × button.
                </p>
              </div>

              <div className="docs-section">
                <h3>⌨️ Keyboard shortcuts</h3>
                <ul>
                  <li>
                    <kbd>Enter</kbd> — send message
                  </li>
                  <li>
                    <kbd>Shift + Enter</kbd> — new line in message
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App