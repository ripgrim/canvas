import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Card, Input, Label } from './atoms'

const PreviewMessage = createContext('This is a local preview')

function LoginContent() {
  const message = useContext(PreviewMessage)
  const [submitted, setSubmitted] = useState(false)
  return <Card heading={<strong>Welcome back</strong>} footer={<span role="status">{submitted ? 'Preview form submitted' : message}</span>}>
    <Label htmlFor="email">Email</Label>
    <Input id="email" type="email" placeholder="you@example.com" />
    <Label htmlFor="password">Password</Label>
    <Input id="password" type="password" />
    <Button onClick={() => setSubmitted(true)}>Sign in</Button>
    {submitted && createPortal(<div role="dialog" aria-label="Preview result"><p>{message}</p><Button onClick={() => setSubmitted(false)}>Close preview</Button></div>, document.body)}
  </Card>
}

export function PreviewLogin() {
  return <PreviewMessage value="This is a local preview"><LoginContent /></PreviewMessage>
}
