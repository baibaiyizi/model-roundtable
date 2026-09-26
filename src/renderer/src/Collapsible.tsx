import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import './collapsible.css'

type SetExpanded = (expanded: boolean) => void
const GroupContext = createContext<Map<string, SetExpanded> | null>(null)

export function CollapseGroup({ children }: { children: ReactNode }) {
  const sections = useRef(new Map<string, SetExpanded>())
  return <GroupContext.Provider value={sections.current}>{children}</GroupContext.Provider>
}

export function CollapseControls() {
  const sections = useContext(GroupContext)
  return <div className="collapse-controls" aria-label="栏目显示"><button type="button" onClick={() => sections?.forEach(set => set(true))}>全部展开</button><button type="button" onClick={() => sections?.forEach(set => set(false))}>全部收起</button></div>
}

/** Native details keep their inputs and running tasks mounted while collapsed. */
export function Collapsible({ id, title, summary, actions, children, defaultOpen = false, forceOpen = false, className = '' }: { id: string; title: ReactNode; summary?: ReactNode; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean; forceOpen?: boolean; className?: string }) {
  const key = `roundtable.section.${id}`
  const [expanded, setExpanded] = useState(() => {
    try { const stored = localStorage.getItem(key); return stored === null ? defaultOpen : stored === 'open' } catch { return defaultOpen }
  })
  const sections = useContext(GroupContext)
  const details = useRef<HTMLDetailsElement>(null)
  const change = useCallback((value: boolean) => {
    setExpanded(value)
    try { localStorage.setItem(key, value ? 'open' : 'closed') } catch { /* A full or disabled browser store must not prevent editing. */ }
  }, [key])
  useEffect(() => { sections?.set(id, change); return () => { sections?.delete(id) } }, [sections, id, change])
  return <details ref={details} className={`collapsible ${className}`} data-section={id} open={forceOpen || expanded} onInvalidCapture={event => {
    // Open synchronously so the browser can focus an invalid field during validation.
    let ancestor = (event.target as HTMLElement).closest('details')
    while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement?.closest('details') ?? null }
    change(true)
  }}>
    <summary onClick={event => {
      if ((event.target as HTMLElement).closest('button, a, input, select')) return
      event.preventDefault()
      if (!forceOpen) change(!expanded)
    }}><ChevronRight className="collapse-chevron" size={17}/><span className="collapse-heading"><span className="collapse-title" role="heading" aria-level={2}>{title}</span>{summary && <span className="collapse-summary">{summary}</span>}</span>{actions && <span className="collapse-actions" onClick={event => { event.preventDefault(); event.stopPropagation() }} onKeyDown={event => event.stopPropagation()}>{actions}</span>}</summary>
    <div className="collapse-content">{children}</div>
  </details>
}
