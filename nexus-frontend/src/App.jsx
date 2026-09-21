import { useState, useRef, useEffect, Component } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  SquarePen,
  MessageSquare,
  X,
  Menu,
  User,
  LogOut,
  Database,
  Mail,
  Phone,
  Clock,
  BookOpen,
  Send,
  ChevronDown,
  Check,
  AlertCircle,
  Zap,
  Rocket,
  Brain,
  FileText,
  Sparkles,
  Wind,
  Bot,
  Gem,
  Layers,
  Sun,
  Moon,
  Plus,
  Paperclip,
  Image,
  File
} from 'lucide-react'
import BlurText from './BlurText'
import SideRays from './SideRays'
import BorderGlow from './BorderGlow'
import AuthModal from './AuthModal.jsx'
import AuthPage from './AuthPage.jsx'
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

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

const STREAM_URL = `${API_URL}/stream`
const SUMMARIZE_URL = `${API_URL}/summarize`

// Provider → brand colour map (module-level so it never re-creates)
const PROVIDER_COLORS = {
  groq: '#D97757',
  mistral: '#6E8EF0',
  chatgpt: '#10a37f',
  gemini: '#E8A820',
  deepseek: '#10a37f',
  ensemble: '#c084fc',
  auto: '#888',
}

const MODEL_ICONS = {
  auto: Sparkles,
  groq: Zap,
  mistral: Wind,
  chatgpt: Bot,
  gemini: Gem,
  deepseek: Brain,
  ensemble: Layers,
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
  { icon: Zap, label: 'Debug & Fix', text: 'Help me debug an issue in my code architecture' },
  { icon: Rocket, label: 'System Design', text: 'Explain how to design a high-throughput SSE microservice in Go' },
  { icon: Brain, label: 'Brainstorm Ideas', text: 'Give me 5 innovative features for an AI assistant web application' },
  { icon: FileText, label: 'Summarize Text', text: 'Summarize the core architectural benefits of cross-model context handoff' },
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

// ─── Custom In-Screen Model Selector Component ──────────
function ModelSelector({ provider, onProviderChange, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const providers = [
    { id: 'auto', name: 'Auto', icon: Sparkles },
    { id: 'groq', name: 'Groq', icon: Zap },
    { id: 'mistral', name: 'Mistral', icon: Wind },
    { id: 'chatgpt', name: 'ChatGPT', icon: Bot },
    { id: 'gemini', name: 'Gemini', icon: Gem },
    { id: 'deepseek', name: 'DeepSeek', icon: Brain },
    { id: 'ensemble', name: 'Ensemble', icon: Layers },
  ]

  const activeProvider = providers.find((p) => p.id === provider) ?? providers[0]
  const ActiveIcon = activeProvider.icon

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [open])

  return (
    <div className="custom-provider-select-wrap" ref={ref}>
      <button
        type="button"
        className={`custom-provider-btn ${open ? 'open' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="Choose AI provider"
      >
        <ActiveIcon size={14} style={{ color: PROVIDER_COLORS[provider] ?? '#888' }} />
        <span className="custom-provider-name">{activeProvider.name}</span>
        <ChevronDown size={13} className="custom-provider-chevron" />
      </button>

      {open && (
        <div className="custom-provider-menu">
          <div className="custom-provider-menu-title">Select Model</div>
          {providers.map((p) => {
            const IconComp = p.icon
            const isSelected = p.id === provider
            return (
              <button
                key={p.id}
                type="button"
                className={`custom-provider-option ${isSelected ? 'active' : ''}`}
                onClick={() => {
                  onProviderChange(p.id)
                  setOpen(false)
                }}
              >
                <IconComp size={14} style={{ color: PROVIDER_COLORS[p.id] ?? '#888', flexShrink: 0 }} />
                <span className="custom-provider-option-name">{p.name}</span>
                {isSelected && <Check size={13} className="custom-provider-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Composer component (MUST be module-level, not nested inside App) ──────────
// Defining it inside App causes it to be re-created on every render, which
// unmounts the <textarea> element after each keystroke — the root cause of the
// "only first character typed" bug.
function Composer({
  prompt,
  onPromptChange,
  onSubmit,
  onKeyDown,
  onProviderChange,
  provider,
  loading,
  switchingModel,
  isEmpty,
  theme,
  attachments = [],
  onAttachFiles,
  onRemoveAttachment
}) {
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      const newHeight = Math.min(textareaRef.current.scrollHeight, 200)
      textareaRef.current.style.height = `${Math.max(newHeight, 36)}px`
    }
  }, [prompt])

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      if (onAttachFiles) {
        onAttachFiles(Array.from(e.target.files))
      }
      e.target.value = ''
    }
  }

  return (
    <div className={`composer-glow-wrap${isEmpty ? ' landing-composer-wrap' : ''}`}>
      <BorderGlow
        borderRadius={22}
        backgroundColor={theme === 'light' ? '#FFFFFF' : '#131318'}
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
          {attachments.length > 0 && (
            <div className="composer-attachments-bar">
              {attachments.map((att) => {
                const isImg = att.type?.startsWith('image/')
                return (
                  <div key={att.id} className="composer-attachment-chip">
                    {isImg ? (
                      <Image size={13} className="attachment-icon" />
                    ) : att.name.endsWith('.pdf') ? (
                      <FileText size={13} className="attachment-icon pdf" />
                    ) : (
                      <Paperclip size={13} className="attachment-icon" />
                    )}
                    <span className="attachment-name">{att.name}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() => onRemoveAttachment && onRemoveAttachment(att.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="composer-inner-row">
            <button
              type="button"
              className="composer-plus-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach files, photos, or PDFs"
              disabled={switchingModel}
            >
              <Plus size={18} />
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              multiple
              accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.md"
              style={{ display: 'none' }}
            />

            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={onPromptChange}
              onKeyDown={onKeyDown}
              placeholder="Message Nexus…"
              rows={1}
              disabled={switchingModel}
              autoFocus
            />

            <div className="composer-actions">
              <ModelSelector
                provider={provider}
                onProviderChange={onProviderChange}
                disabled={switchingModel}
              />
              <button
                type="submit"
                disabled={loading || switchingModel || (!prompt.trim() && attachments.length === 0)}
                aria-label="Send"
              >
                {loading ? '…' : <Send size={14} style={{ display: 'block', margin: 'auto' }} />}
              </button>
            </div>
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
  const [attachments, setAttachments] = useState([])
  const [provider, setProvider] = useState('auto')

  const handleAttachFiles = (files) => {
    const newAtts = files.map((file) => ({
      id: Math.random().toString(36).substring(2, 9),
      file,
      name: file.name,
      size: file.size,
      type: file.type,
    }))
    setAttachments((prev) => [...prev, ...newAtts])
  }

  const handleRemoveAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }
  const [loading, setLoading] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768
    }
    return false
  })
  const [historyOpen, setHistoryOpen] = useState(false)
  // Auth state
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [recoveryMode, setRecoveryMode] = useState(() => {
    try {
      const hash = window.location.hash || ''
      const search = window.location.search || ''
      return hash.includes('type=recovery') || search.includes('type=recovery') || search.includes('code=')
    } catch {
      return false
    }
  })
  const [isGuest, setIsGuest] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('nexus-guest-mode') === 'true'
    }
    return false
  })

  // Close dropdowns on outside click
  useEffect(() => {
    if (!contactOpen && !profileOpen) return
    const close = () => {
      setContactOpen(false)
      setProfileOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contactOpen, profileOpen])
  const [authReady, setAuthReady] = useState(false)
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('nexus-theme') || 'dark'
    }
    return 'dark'
  })
  const bottomRef = useRef(null)

  const currentConv = conversations.find((c) => c.id === currentId) ?? conversations[0]
  const messages = currentConv?.messages ?? []
  const isEmpty = messages.length === 0

  // Responsive sidebar handling: Guarantee sidebar is hidden on mobile launch & on resize
  useEffect(() => {
    const checkViewport = () => {
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
    }
    checkViewport()
    window.addEventListener('resize', checkViewport)
    return () => window.removeEventListener('resize', checkViewport)
  }, [])

  // ── On mount: restore Supabase session (if env vars are set) ──
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthReady(true)
      return
    }
    supabase.auth.getSession()
      .then(({ data }) => {
        setSession(data?.session ?? null)
        setUser(data?.session?.user ?? null)
      })
      .catch((err) => {
        console.warn('Supabase getSession failed:', err)
      })
      .finally(() => {
        setAuthReady(true)
      })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (_event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true)
      }
      setSession(session ?? null)
      setUser(session?.user ?? null)
      if (session) {
        setIsGuest(false)
        localStorage.removeItem('nexus-guest-mode')
      }
    })
    return () => listener?.subscription?.unsubscribe()
  }, [])


  useEffect(() => {
    localStorage.setItem('nexus-convs', JSON.stringify(conversations))
  }, [conversations])

  // ── Theme: sync data-theme attribute & persist ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('nexus-theme', theme)
  }, [theme])

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
      const headers = { 'Content-Type': 'application/json' }
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`
      }
      const res = await fetch(SUMMARIZE_URL, {
        method: 'POST',
        headers,
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
    const rawText = prompt.trim()
    if ((!rawText && attachments.length === 0) || loading || switchingModel) return

    let text = rawText
    if (attachments.length > 0) {
      const attachNotice = attachments.map((a) => `📎 [Attached File: ${a.name}]`).join('\n')
      text = rawText ? `${attachNotice}\n\n${rawText}` : attachNotice
    }

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
    setAttachments([])
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
      const headers = { 'Content-Type': 'application/json' }
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`
      }
      const res = await fetch(STREAM_URL, {
        method: 'POST',
        headers,
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
            } else if (currentEvent === 'memory_rag') {
              updateConv(targetId, (c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m._id === streamingMsgId ? { ...m, memoryAugmented: true } : m
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
      let displayMsg = isNetworkErr
        ? `⚠️ Cannot reach the Nexus backend (${API_URL}). Make sure the backend server is running.`
        : err.message

      // Clean up raw JSON error payloads if present
      if (displayMsg.includes('API error') || displayMsg.includes('Rate limit exceeded')) {
        try {
          const jsonMatch = displayMsg.match(/\{.*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (parsed.message) {
              displayMsg = `${displayMsg.split('{')[0].trim()}: ${parsed.message}`
            }
          }
        } catch {
          // ignore
        }
      }

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
    theme,
    attachments,
    onAttachFiles: handleAttachFiles,
    onRemoveAttachment: handleRemoveAttachment,
  }

  if (authReady && (!session || recoveryMode) && !isGuest) {
    return (
      <AuthPage
        theme={theme}
        initialTab={recoveryMode ? 'update' : 'signin'}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
        onAuthSuccess={(u, s) => {
          setUser(u)
          setSession(s)
          setRecoveryMode(false)
          setIsGuest(false)
          localStorage.removeItem('nexus-guest-mode')
        }}
        onGuestMode={() => {
          setIsGuest(true)
          localStorage.setItem('nexus-guest-mode', 'true')
        }}
      />
    )
  }

  return (
    <div className="page">
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
            <SquarePen size={16} />
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
              <span className="sidebar-item-icon"><MessageSquare size={14} /></span>
              <span className="sidebar-item-title">{conv.title}</span>
              {conv.provider && conv.provider !== 'auto' && (() => {
                const IconComp = MODEL_ICONS[conv.provider] ?? Sparkles
                return (
                  <IconComp
                    size={13}
                    style={{ color: PROVIDER_COLORS[conv.provider] ?? '#888', flexShrink: 0, marginLeft: 'auto' }}
                    title={conv.provider}
                  />
                )
              })()}
              <button
                className="sidebar-delete"
                onClick={(e) => deleteConv(conv.id, e)}
                title="Delete"
              >
                <X size={14} />
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
            <Menu size={18} />
          </button>
          <div className="topbar-actions">
            {/* 1. Cloud history panel */}
            <button className="docs-btn" onClick={() => setHistoryOpen(true)} title="History">
              <span className="docs-btn-icon"><Database size={14} /></span>
              <span className="topbar-btn-text">History</span>
            </button>

            {/* 2. Theme toggle */}
            <button
              className="docs-btn"
              onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <span className="docs-btn-icon">
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              </span>
              <span className="topbar-btn-text">
                {theme === 'dark' ? 'Light' : 'Dark'}
              </span>
            </button>

            {/* 3. Contact dropdown */}
            <div className="topbar-dropdown-wrap">
              <button className="docs-btn" onClick={(e) => { e.stopPropagation(); setContactOpen((v) => !v); }} title="Contact">
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

            {/* 4. Docs link */}
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

            {/* 5. Circular Profile Avatar / Guest Mode - Placed AFTER Docs */}
            {user ? (
              <div className="topbar-dropdown-wrap">
                <button
                  className="profile-avatar-btn"
                  onClick={(e) => { e.stopPropagation(); setProfileOpen((v) => !v); }}
                  title={user.email}
                >
                  <span className="profile-initial">
                    {user.email ? user.email.charAt(0).toUpperCase() : <User size={14} />}
                  </span>
                </button>
                {profileOpen && (
                  <div className="topbar-dropdown profile-dropdown" onClick={(e) => e.stopPropagation()}>
                    <div className="profile-dropdown-header">
                      <span className="profile-dropdown-avatar">
                        {user.email ? user.email.charAt(0).toUpperCase() : <User size={14} />}
                      </span>
                      <div className="profile-dropdown-info">
                        <p className="profile-dropdown-email">{user.email}</p>
                        <span className="profile-dropdown-badge">Authenticated</span>
                      </div>
                    </div>
                    <div className="profile-dropdown-divider" />
                    <button
                      className="profile-dropdown-signout"
                      onClick={async () => {
                        await supabase.auth.signOut()
                        setSession(null)
                        setUser(null)
                        setIsGuest(false)
                        localStorage.removeItem('nexus-guest-mode')
                        setProfileOpen(false)
                      }}
                    >
                      <LogOut size={14} />
                      <span>Sign Out</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                className="profile-avatar-btn guest"
                title="Guest Mode — Click to Sign in"
                onClick={() => {
                  setIsGuest(false)
                  localStorage.removeItem('nexus-guest-mode')
                }}
              >
                <User size={14} />
              </button>
            )}
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
                {STARTER_PROMPTS.map((chip, idx) => {
                  const IconComp = chip.icon
                  return (
                    <button
                      key={idx}
                      className="starter-chip"
                      onClick={() => setPrompt(chip.text)}
                    >
                      <span className="starter-chip-icon"><IconComp size={15} /></span>
                      <span className="starter-chip-label">{chip.label}</span>
                    </button>
                  )
                })}
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
                            <span>{m.provider}</span>
                            {m.memoryAugmented && (
                              <span className="rag-badge" title="Retrieved semantic memory context via Vector Search">
                                <Brain size={11} /> RAG Memory
                              </span>
                            )}
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
                          ) : m.role === 'error' ? (
                            <div className="error-bubble-body">
                              <p style={{ margin: 0, lineHeight: 1.5 }}>{m.text}</p>
                              {(String(m.text).toLowerCase().includes('rate limit') ||
                                String(m.text).includes('429') ||
                                String(m.text).toLowerCase().includes('quota') ||
                                String(m.text).toLowerCase().includes('unavailable')) && (
                                <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                  <button
                                    type="button"
                                    onClick={() => handleProviderChange('groq')}
                                    style={{
                                      background: 'rgba(245, 80, 54, 0.15)',
                                      border: '1px solid rgba(245, 80, 54, 0.5)',
                                      color: '#ff8a75',
                                      padding: '5px 12px',
                                      borderRadius: '6px',
                                      cursor: 'pointer',
                                      fontSize: '12px',
                                      fontWeight: 500,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px'
                                    }}
                                  >
                                    ⚡ Switch to Groq (Fast & Active)
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleProviderChange('gemini')}
                                    style={{
                                      background: 'rgba(56, 189, 248, 0.15)',
                                      border: '1px solid rgba(56, 189, 248, 0.5)',
                                      color: '#7dd3fc',
                                      padding: '5px 12px',
                                      borderRadius: '6px',
                                      cursor: 'pointer',
                                      fontSize: '12px',
                                      fontWeight: 500,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px'
                                    }}
                                  >
                                    ✨ Switch to Gemini (Active)
                                  </button>
                                </div>
                              )}
                            </div>
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
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} session={session} />}
    </div>
  )
}

export default App