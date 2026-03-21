import React from 'react'
import ReactDOM from 'react-dom/client'
import SpecEditor from './App.jsx'
import './styles/editor.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 40, maxWidth: 600, margin: '80px auto',
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}>
          <h1 style={{ fontSize: 20, color: '#dc2626', marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: '#475569', fontSize: 14, marginBottom: 16 }}>
            The editor encountered an unexpected error. Your work has been auto-saved to browser storage.
          </p>
          <pre style={{
            fontSize: 12, color: '#991b1b', backgroundColor: '#fef2f2',
            padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 200,
          }}>{this.state.error?.message || 'Unknown error'}</pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16, padding: '8px 20px', backgroundColor: '#2563eb',
              color: 'white', border: 'none', borderRadius: 6, fontSize: 14,
              cursor: 'pointer', fontWeight: 600,
            }}
          >Reload Editor</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SpecEditor />
    </ErrorBoundary>
  </React.StrictMode>,
)
