import { useState, useRef, useEffect } from 'react'
import BlurText from './BlurText'
import SideRays from './SideRays'
import './App.css'

const API_URL = 'http://localhost:8080/query'

function App() {
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('auto')
  const [loading, setLoading] = useState(false)
  const [greetStep, setGreetStep] = useState(0)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSubmit(e) {
    e.preventDefault()
    const text = prompt.trim()
    if (!text || loading) return

    const userMessage = { role: 'user', text }
    setMessages((prev) => [...prev, userMessage])
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
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: data.answer,
          provider: data.provider,
          rawAnswers: data.raw_answers,
        },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', text: err.message },
      ])
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

  const isEmpty = messages.length === 0

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

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <span className="brand-name">Nexus</span>
        </div>
        <select
          className="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="auto">Auto</option>
          <option value="groq">Groq</option>
          <option value="mistral">Mistral</option>
          <option value="ensemble">Ensemble</option>
        </select>
      </header>

      <div className="page-inner">
        <main className={`conversation ${isEmpty ? 'centered' : ''}`}>
          {isEmpty ? (
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
                One prompt, routed across Groq and Mistral — or merged into a single, cross-validated answer.
              </p>
            </div>
          ) : (
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
                    <span></span><span></span><span></span>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Nexus..."
            rows={1}
          />
          <button type="submit" disabled={loading || !prompt.trim()} aria-label="Send">
            ↑
          </button>
        </form>
      </div>
    </div>
  )
}

export default App