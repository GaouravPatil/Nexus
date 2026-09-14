import { useState } from 'react'
import {
  Sparkles,
  Zap,
  Wind,
  Bot,
  Gem,
  Layers,
  ArrowRight,
  ShieldCheck,
  Cpu,
  RefreshCw,
  UserCheck,
  Lock,
  Mail,
  Phone,
  Clock,
  BookOpen,
  Sun,
  Moon
} from 'lucide-react'
import { supabase, isSupabaseConfigured } from './supabaseClient.js'
import SideRays from './SideRays.jsx'
import BlurText from './BlurText.jsx'
import BorderGlow from './BorderGlow.jsx'
import './AuthPage.css'

export default function AuthPage({ theme = 'dark', onToggleTheme, onAuthSuccess, onGuestMode }) {
  const [tab, setTab] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setLoading(true)

    try {
      if (!isSupabaseConfigured) {
        throw new Error('Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to nexus-frontend/.env')
      }

      if (tab === 'signin') {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onAuthSuccess(data.user, data.session)
      } else {
        // Registers account directly into Supabase auth database
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error

        if (data?.session) {
          onAuthSuccess(data.user, data.session)
        } else if (data?.user) {
          // Attempt immediate login (works if Supabase auto-confirms users)
          const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
          if (!signInErr && signInData?.session) {
            onAuthSuccess(signInData.user, signInData.session)
          } else {
            setInfo('Account created successfully in Supabase! Check your email for confirmation or sign in.')
            setTab('signin')
          }
        }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page" data-theme={theme}>
      <SideRays
        speed={2.2}
        rayColor1={theme === 'light' ? '#F0A78A' : '#D97757'}
        rayColor2={theme === 'light' ? '#A3B8F0' : '#6E8EF0'}
        intensity={theme === 'light' ? 0.8 : 1.6}
        spread={1.8}
        origin="top-right"
        tilt={0}
        saturation={1.3}
        blend={0.7}
        falloff={1.7}
        opacity={theme === 'light' ? 0.35 : 0.9}
        className="auth-page-rays"
      />

      {/* ── Top Header Matching Main Landing Topbar ── */}
      <header className="auth-topbar">
        <div className="auth-brand">
          <svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" className="auth-brand-logo">
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#D97757" transform="rotate(0 28 28)" />
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#E8A820" transform="rotate(120 28 28)" />
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#6E8EF0" transform="rotate(240 28 28)" />
            <circle cx="28" cy="28" r="4.5" fill="#F2F1EE" />
          </svg>
          <span className="auth-brand-name">Nexus</span>
          <span className="auth-brand-badge">v2.0 Architecture</span>
        </div>

        <div className="topbar-actions">
          {/* Theme toggle */}
          {onToggleTheme && (
            <button
              className="docs-btn"
              onClick={onToggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <span className="docs-btn-icon">
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              </span>
              <span className="topbar-btn-text">
                {theme === 'dark' ? 'Light' : 'Dark'}
              </span>
            </button>
          )}

          {/* Contact dropdown */}
          <div className="topbar-dropdown-wrap">
            <button
              className="docs-btn"
              onClick={(e) => { e.stopPropagation(); setContactOpen((v) => !v); }}
              title="Contact"
            >
              <span className="docs-btn-icon"><Mail size={14} /></span>
              <span className="topbar-btn-text">Contact</span>
            </button>
            {contactOpen && (
              <div className="topbar-dropdown" onClick={(e) => e.stopPropagation()}>
                <p className="topbar-dropdown-heading">Get in touch</p>
                <ul className="topbar-contact-list">
                  <li>
                    <span className="contact-icon"><Mail size={14} /></span>
                    <a href="mailto:patilgaourav304@gmail.com" className="contact-link">
                      patilgaourav304@gmail.com
                    </a>
                  </li>
                  <li>
                    <span className="contact-icon"><Phone size={14} /></span>
                    <a href="tel:+919834892067" className="contact-link">
                      +91 98348 92067
                    </a>
                  </li>
                  <li>
                    <span className="contact-icon"><Clock size={14} /></span>
                    <span className="contact-available">Available 24 / 7</span>
                  </li>
                </ul>
              </div>
            )}
          </div>

          {/* Docs link */}
          <a
            href="https://github.com/GaouravPatil/Nexus#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="docs-btn"
            title="View GitHub Documentation"
          >
            <span className="docs-btn-icon"><BookOpen size={14} /></span>
            <span className="topbar-btn-text">Docs</span>
          </a>

          {/* Guest mode button */}
          <button className="topbar-guest-btn" onClick={onGuestMode} title="Try as guest">
            <UserCheck size={14} />
            <span>Guest Mode</span>
          </button>
        </div>
      </header>

      <div className="auth-page-container">
        {/* Left Column: Hero & Capabilities */}
        <div className="auth-hero">
          <div className="auth-hero-header">
            <BlurText
              text="Talk to any AI. Switch models seamlessly. Never lose context."
              animateBy="words"
              direction="top"
              className="auth-hero-title-blur"
            />
          </div>

          <p className="auth-hero-subtitle">
            An advanced multi-provider AI orchestration platform featuring Cross-Model Persistent Memory (CMPM), real-time SSE streaming, and intelligent synthesis.
          </p>

          <div className="auth-features-grid">
            <div className="auth-feature-card">
              <div className="auth-feature-icon" style={{ background: 'rgba(217, 119, 87, 0.15)', color: '#D97757' }}>
                <Cpu size={18} />
              </div>
              <div className="auth-feature-content">
                <h4>Multi-Model Engine</h4>
                <p>Hot-swap between Groq Llama 3.3, Mistral, ChatGPT 4o mini, and Gemini Flash.</p>
              </div>
            </div>

            <div className="auth-feature-card">
              <div className="auth-feature-icon" style={{ background: 'rgba(110, 142, 240, 0.15)', color: '#6E8EF0' }}>
                <RefreshCw size={18} />
              </div>
              <div className="auth-feature-content">
                <h4>Zero-Gap Handoff</h4>
                <p>AI-generated context briefs transfer complete chat state when switching models.</p>
              </div>
            </div>

            <div className="auth-feature-card">
              <div className="auth-feature-icon" style={{ background: 'rgba(192, 132, 252, 0.15)', color: '#c084fc' }}>
                <Layers size={18} />
              </div>
              <div className="auth-feature-content">
                <h4>Ensemble Mode</h4>
                <p>Fan-out prompts in parallel to multiple LLMs and synthesize an optimal response.</p>
              </div>
            </div>

            <div className="auth-feature-card">
              <div className="auth-feature-icon" style={{ background: 'rgba(232, 168, 32, 0.15)', color: '#E8A820' }}>
                <ShieldCheck size={18} />
              </div>
              <div className="auth-feature-content">
                <h4>Secure Cloud Storage</h4>
                <p>User-scoped encrypted query logs and persistent conversation history.</p>
              </div>
            </div>
          </div>

          <div className="auth-providers-strip">
            <span className="strip-label">Supported Providers</span>
            <div className="strip-icons">
              <span className="strip-tag" style={{ borderColor: 'rgba(217, 119, 87, 0.3)', color: '#D97757' }}><Zap size={12} /> Groq</span>
              <span className="strip-tag" style={{ borderColor: 'rgba(110, 142, 240, 0.3)', color: '#6E8EF0' }}><Wind size={12} /> Mistral</span>
              <span className="strip-tag" style={{ borderColor: 'rgba(16, 163, 127, 0.3)', color: '#10a37f' }}><Bot size={12} /> OpenAI</span>
              <span className="strip-tag" style={{ borderColor: 'rgba(232, 168, 32, 0.3)', color: '#E8A820' }}><Gem size={12} /> Gemini</span>
            </div>
          </div>
        </div>

        {/* Right Column: Authentication Card */}
        <div className="auth-card-wrap">
          <BorderGlow
            className="auth-border-glow"
            glowColor={theme === 'light' ? '14 70 60' : '14 70 55'}
            backgroundColor={theme === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(22, 23, 30, 0.85)'}
            borderRadius={24}
            glowIntensity={0.8}
            fillOpacity={0.4}
          >
            <div className="auth-card">
              <div className="auth-tabs">
                <button
                  type="button"
                  className={`auth-tab ${tab === 'signin' ? 'active' : ''}`}
                  onClick={() => { setTab('signin'); setError(null); setInfo(null) }}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className={`auth-tab ${tab === 'signup' ? 'active' : ''}`}
                  onClick={() => { setTab('signup'); setError(null); setInfo(null) }}
                >
                  Create Account
                </button>
              </div>

              <div className="auth-card-header">
                <h3>{tab === 'signin' ? 'Welcome Back' : 'Get Started with Nexus'}</h3>
                <p>
                  {tab === 'signin'
                    ? 'Sign in to access your user-scoped conversation history and cloud sync.'
                    : 'Create an account to save histories securely across devices.'}
                </p>
              </div>

              <form onSubmit={handleSubmit} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">Email Address</label>
                  <div className="auth-input-wrap">
                    <Mail size={16} className="auth-input-icon" />
                    <input
                      type="email"
                      className="auth-input"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label className="auth-label">Password</label>
                  <div className="auth-input-wrap">
                    <Lock size={16} className="auth-input-icon" />
                    <input
                      type="password"
                      className="auth-input"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      minLength={6}
                    />
                  </div>
                </div>

                {error && <div className="auth-alert error"><p>{error}</p></div>}
                {info && <div className="auth-alert info"><p>{info}</p></div>}

                <button type="submit" className="auth-submit-btn" disabled={loading}>
                  {loading ? (
                    <span className="btn-spinner-wrap">
                      <span className="btn-spinner" /> Authenticating…
                    </span>
                  ) : (
                    <>
                      <span>{tab === 'signin' ? 'Sign In to Workspace' : 'Create Account'}</span>
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </form>

              <div className="auth-divider">
                <span>OR</span>
              </div>

              <button type="button" className="auth-guest-btn" onClick={onGuestMode}>
                <UserCheck size={16} />
                <span>Try Nexus as Guest</span>
              </button>
              <p className="auth-guest-note">Guest mode enables full access to all AI models with standard guest rate limits.</p>
            </div>
          </BorderGlow>
        </div>
      </div>
    </div>
  )
}
