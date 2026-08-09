import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import './AuthModal.css'

export default function AuthModal({ onAuth }) {
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setLoading(true)
    try {
      if (tab === 'login') {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onAuth(data.user)
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setInfo('Check your email for a confirmation link, then log in.')
        setTab('login')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-overlay">
      <div className="auth-panel">
        <div className="auth-logo">
          <svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#D97757" transform="rotate(0 28 28)" />
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#E8A820" transform="rotate(120 28 28)" />
            <ellipse cx="28" cy="17" rx="7" ry="17" fill="#6E8EF0" transform="rotate(240 28 28)" />
            <circle cx="28" cy="28" r="4.5" fill="#F2F1EE" />
          </svg>
          <span>Nexus</span>
        </div>

        <h2 className="auth-title">
          {tab === 'login' ? 'Welcome back' : 'Create account'}
        </h2>
        <p className="auth-sub">
          {tab === 'login'
            ? 'Sign in to access your conversations across devices.'
            : 'Sign up to sync your chats to the cloud.'}
        </p>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
            onClick={() => { setTab('login'); setError(null); setInfo(null) }}
          >Login</button>
          <button
            className={`auth-tab ${tab === 'signup' ? 'active' : ''}`}
            onClick={() => { setTab('signup'); setError(null); setInfo(null) }}
          >Sign up</button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label className="auth-label">
            Email
            <input
              type="email"
              className="auth-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
            />
          </label>
          <label className="auth-label">
            Password
            <input
              type="password"
              className="auth-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}
          {info  && <p className="auth-info">{info}</p>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Please wait…' : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-skip" onClick={() => onAuth(null)}>
          Continue without account →
        </p>
      </div>
    </div>
  )
}
