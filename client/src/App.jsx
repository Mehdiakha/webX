import { useEffect, useMemo, useState } from 'react'
import './index.css'

const API_URL = import.meta.env.VITE_API_URL || ''

const PLATFORM_OPTIONS = [
  { id: 'webflow', label: 'Webflow' },
  { id: 'squarespace', label: 'Squarespace' },
  { id: 'framer', label: 'Framer' }
]

const createDefaultOptions = () => ({
  platform: 'webflow',
  exportCss: true,
  cssFolderName: 'css',
  exportJs: true,
  jsFolderName: 'js',
  exportImages: false,
  exportAllPages: false,
  removeWatermarks: true,
  htmlExtension: false,
  maxDepth: 3
})

function App() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('idle')
  const [exportId, setExportId] = useState(null)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [downloadUrl, setDownloadUrl] = useState(null)
  const [fileSize, setFileSize] = useState(null)
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState(null)
  const [options, setOptions] = useState(createDefaultOptions())

  useEffect(() => {
    document.title = 'webX'
  }, [])

  const platformLabel = useMemo(() => {
    return PLATFORM_OPTIONS.find((option) => option.id === options.platform)?.label ?? 'Webflow'
  }, [options.platform])

  useEffect(() => {
    if (!exportId || status !== 'processing') return

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/export/${exportId}/status`)
        const data = await res.json()

        setProgress(data.progress)
        setMessage(data.message)

        if (data.status === 'completed') {
          setStatus('completed')
          setDownloadUrl(data.downloadUrl)
          setFileSize(data.fileSize)
          setMeta(data.meta)
          clearInterval(interval)
        } else if (data.status === 'error') {
          setStatus('error')
          setError(data.message)
          clearInterval(interval)
        }
      } catch (pollError) {
        console.error('Polling error:', pollError)
      }
    }, 500)

    return () => clearInterval(interval)
  }, [exportId, status])

  const handleExport = async () => {
    if (!url.trim()) return

    setStatus('processing')
    setExportId(null)
    setProgress(0)
    setMessage('Starting...')
    setDownloadUrl(null)
    setFileSize(null)
    setError(null)
    setMeta(null)

    try {
      const res = await fetch(`${API_URL}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), options })
      })

      const data = await res.json()

      if (data.error) {
        setStatus('error')
        setError(data.error)
        return
      }

      setExportId(data.exportId)
    } catch {
      setStatus('error')
      setError('Failed to connect to server')
    }
  }

  const handleReset = () => {
    setUrl('')
    setStatus('idle')
    setExportId(null)
    setProgress(0)
    setMessage('')
    setDownloadUrl(null)
    setFileSize(null)
    setError(null)
    setMeta(null)
    setOptions(createDefaultOptions())
  }

  const stage = progress < 30 ? 1 : progress < 70 ? 2 : 3
  const folderEntries = Object.entries(meta?.folders || {})

  return (
    <div className="app">
      <main className="main">
        <div className="card">
          <div className="brand-row">
            <div className="brand-block">
              <img src="/logo.png" alt="site logo" className="brand-logo" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="domain-name" className="field-label">Domain Name</label>
            <input
              id="domain-name"
              type="text"
              className="url-input"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleExport()}
              disabled={status === 'processing'}
            />
          </div>

          <div className="field">
            <span className="field-label">Platform</span>
            <div className="platform-group" role="tablist" aria-label="Platform selector">
              {PLATFORM_OPTIONS.map((platform) => (
                <button
                  key={platform.id}
                  type="button"
                  className={`platform-btn ${options.platform === platform.id ? 'active' : ''}`}
                  onClick={() => setOptions({ ...options, platform: platform.id })}
                  disabled={status === 'processing'}
                >
                  {platform.label}
                </button>
              ))}
            </div>
          </div>

          <div className="options-panel">
            <div className="option">
              <div className="option-info">
                <span className="option-title">Export CSS Files</span>
                <span className="option-desc">Saved into the {options.cssFolderName || 'css'} folder</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.exportCss}
                  onChange={(e) => setOptions({ ...options, exportCss: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="field compact-field">
              <label className="field-label field-label-small" htmlFor="css-folder">CSS Folder Name</label>
              <input
                id="css-folder"
                type="text"
                className="text-input"
                value={options.cssFolderName}
                onChange={(e) => setOptions({ ...options, cssFolderName: e.target.value })}
                disabled={status === 'processing'}
              />
            </div>

            <div className="option">
              <div className="option-info">
                <span className="option-title">Export JS Files</span>
                <span className="option-desc">Saved into the {options.jsFolderName || 'js'} folder</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.exportJs}
                  onChange={(e) => setOptions({ ...options, exportJs: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="field compact-field">
              <label className="field-label field-label-small" htmlFor="js-folder">JS Folder Name</label>
              <input
                id="js-folder"
                type="text"
                className="text-input"
                value={options.jsFolderName}
                onChange={(e) => setOptions({ ...options, jsFolderName: e.target.value })}
                disabled={status === 'processing'}
              />
            </div>

            <div className="option">
              <div className="option-info">
                <span className="option-title">Export Images / Media Files</span>
                <span className="option-desc">Images, media, and fonts stay grouped</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.exportImages}
                  onChange={(e) => setOptions({ ...options, exportImages: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="option">
              <div className="option-info">
                <span className="option-title">Export all pages</span>
                <span className="option-desc">Crawl and include linked pages</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.exportAllPages}
                  onChange={(e) => setOptions({ ...options, exportAllPages: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="option">
              <div className="option-info">
                <span className="option-title">Remove &quot;Made with&quot; Badge</span>
                <span className="option-desc">Remove platform branding and badges</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.removeWatermarks}
                  onChange={(e) => setOptions({ ...options, removeWatermarks: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="option">
              <div className="option-info">
                <span className="option-title">Pages should be exported with .html extension</span>
                <span className="option-desc">Keep page URLs as explicit HTML files</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.htmlExtension}
                  onChange={(e) => setOptions({ ...options, htmlExtension: e.target.checked })}
                  disabled={status === 'processing'}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="selected-platform">Platform: {platformLabel}</div>

          {status === 'processing' && (
            <div className="progress-panel">
              <div className="progress-header">
                <span className="progress-stage">Stage {stage} of 3</span>
                <span className="progress-percent">{progress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }}></div>
              </div>
              <div className="progress-message">{message}</div>
              <div className="progress-dots">
                {[1, 2, 3].map((step) => (
                  <div key={step} className={`dot ${step < stage ? 'done' : ''} ${step === stage ? 'active' : ''}`}></div>
                ))}
              </div>
            </div>
          )}

          <button
            className="btn-export"
            onClick={handleExport}
            disabled={status === 'processing' || !url.trim()}
          >
            {status === 'processing' ? (
              <>
                <span className="spinner"></span>
                <span>Exporting</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Export</span>
              </>
            )}
          </button>
        </div>

        {status === 'completed' && meta && (
          <div className="result-card">
            <div className="result-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20,6 9,17 4,12" />
              </svg>
            </div>
            <h2 className="result-title">Export Complete!</h2>
            <p className="result-size">{fileSize} MB</p>

            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-value">{meta.htmlPages || 0}</span>
                <span className="stat-label">Pages</span>
              </div>
              {folderEntries.map(([folderName, folderStat]) => (
                <div key={folderName} className="stat-item">
                  <span className="stat-value">{folderStat.count || 0}</span>
                  <span className="stat-label">{folderName}</span>
                </div>
              ))}
              <div className="stat-item">
                <span className="stat-value">{meta.totalFiles || 0}</span>
                <span className="stat-label">Total</span>
              </div>
            </div>

            <div className="result-actions">
              <a
                className="btn-download"
                href={`${API_URL}${downloadUrl}`}
                download="website-export.zip"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download ZIP
              </a>

              <button className="btn-reset" onClick={handleReset}>
                Export Another
              </button>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="error-card">
            <div className="error-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <h2 className="error-title">Export Failed</h2>
            <p className="error-message">{error || 'An unexpected error occurred'}</p>
            <button className="btn-reset" onClick={handleReset}>
              Try Again
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
