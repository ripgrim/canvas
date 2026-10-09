import type { CSSProperties } from 'react'
import './brand.css'

/** Supplied Comp mark: exact path and viewBox, 122:110 aspect ratio, filled with the current text color. */
export function CompLogo({ height = 20, label, className }: { height?: number; label?: string; className?: string }) {
  const style = { height, width: height * (122 / 110) } as CSSProperties
  return <svg className={['comp-logo', className].filter(Boolean).join(' ')} viewBox="0 0 122 110" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'} focusable="false" fill="currentColor" style={style}>
    <path d="M91.28 21.885L87.478 19.241L61.012 0.851L0.444 42.92V66.966L61.004 109.043L121.555 66.966V42.92L91.272 21.885H91.28ZM61.012 11.446L79.861 24.546L70.181 31.267L69.319 31.866L61.02 26.102L36.794 42.928L45.094 48.7L52.712 53.998L61.012 59.77L85.229 42.936L76.937 37.172L77.799 36.572L87.478 29.851L106.32 42.944L96.64 49.673L61.012 74.426L42.163 61.326L34.545 56.036L25.375 49.673L15.696 42.944L61.012 11.446Z" />
  </svg>
}

/** The product wordmark: the Comp mark followed by lowercase "canvas", read by assistive technology as the full product name. */
export function CompCanvasWordmark({ height = 20, label }: { height?: number; label: string }) {
  return <span className="comp-wordmark" role="img" aria-label={label} style={{ '--brand-height': `${height}px` } as CSSProperties}><CompLogo height={height} /><span className="comp-wordmark-text" aria-hidden="true">canvas</span></span>
}
