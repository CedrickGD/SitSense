import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { Button, EmptyState } from './primitives'

interface Props {
  children: ReactNode
}

/**
 * A render error in one screen must not blank the whole window. Detection
 * lives outside React, so monitoring and nudges carry on regardless.
 */
export default class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] screen crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <Crashed />
  }
}

function Crashed(): JSX.Element {
  return (
    <EmptyState
      icon={
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <path d="M12 3l9.5 17h-19z" />
          <path d="M12 10v4.5M12 17.5v.01" />
        </svg>
      }
      headline="This screen hit a snag"
      body="Monitoring keeps running in the background. Reload the window to get the screen back."
      actions={
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  )
}
