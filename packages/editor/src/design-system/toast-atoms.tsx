import type { ReactNode } from 'react'
import { Toast } from '@base-ui/react/toast'
import { Icon } from './atoms'
import './toast.css'

type ToastData = Readonly<{ status: 'error' | 'info' | 'success' }>

export const toastManager = Toast.createToastManager<ToastData>()

export const editorToast = Object.freeze({
  error(title: string, description: string) {
    return toastManager.add({ title, description, type: 'error', priority: 'high', data: { status: 'error' } })
  },
  close() { toastManager.close() },
})

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>()
  return toasts.map(item => <Toast.Root key={item.id} toast={item} className="toast-root" data-status={item.data?.status ?? item.type} swipeDirection="right">
    <Toast.Content className="toast-content">
      <span className="toast-status" aria-hidden="true"><Icon name="alert" /></span>
      <span className="toast-copy">
        <Toast.Title className="toast-title" />
        <Toast.Description className="toast-description" />
      </span>
      <Toast.Close className="toast-close" aria-label="Dismiss"><Icon name="close" /></Toast.Close>
    </Toast.Content>
  </Toast.Root>)
}

export function ToastRegion({ mode, children }: { mode: 'light' | 'dark'; children: ReactNode }) {
  return <Toast.Provider toastManager={toastManager} limit={3} timeout={5000}>
    {children}
    <Toast.Portal>
      <Toast.Viewport className={`theme-${mode} toast-viewport`}>
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
}
