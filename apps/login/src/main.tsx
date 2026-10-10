import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SignInPage } from './pages/SignInPage'
import { hostedLoginService } from './features/sign-in/hosted-login-service'

hostedLoginService.start()
const root = document.getElementById('root')
if (!root) throw new Error('Login root is missing.')
createRoot(root).render(createElement(StrictMode, null, createElement(SignInPage)))
