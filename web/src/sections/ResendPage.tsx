/**
 * "Send my link again" (#70).
 *
 * The email a customer typed at checkout is the only identifier this product
 * has, so this is the whole of account recovery.
 *
 * It ALWAYS says the same thing. Telling a stranger whether an address has
 * bought something is account enumeration, and it would be a strange thing to
 * leak on a site about hypnosis. The server answers 202 either way; this page
 * shows the same sentence either way; and neither of them waits on the search,
 * so the response cannot be timed either.
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RETENTION_WINDOW, SUPPORT_EMAIL } from '@/lib/legal'
import SiteFooter from '@/components/SiteFooter'

export default function ResendPage({
  onHome,
  onNavigate,
}: {
  onHome: () => void
  onNavigate: (path: string) => void
}) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-5">
        <button
          onClick={onHome}
          className="text-xs uppercase tracking-[0.3em] text-white/50 transition-colors hover:text-white/80"
        >
          Hypnosis Studio
        </button>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-md">
          <div className="text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Your programs</p>
            <h1 className="font-display mt-4 text-4xl leading-tight text-[#e8e6f0]">
              Send my link again.
            </h1>
            <p className="mx-auto mt-4 text-sm leading-relaxed text-white/50">
              There are no accounts here. Enter the email address you used at
              checkout and we will send the link to your programs again.
            </p>
          </div>

          {done ? (
            <div
              role="status"
              className="mt-10 rounded-2xl border border-violet-300/30 bg-violet-300/5 p-7 text-center"
            >
              <p className="text-sm leading-relaxed text-white/80">
                If that address has a program with us, the link is on its way.
              </p>
              <p className="mt-4 text-xs leading-relaxed text-white/50">
                Nothing arrived? Check the address you typed, and remember that
                finished renders are kept for {RETENTION_WINDOW} — after that
                there is no file left to link to. If you are still stuck,{' '}
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="text-violet-300 underline underline-offset-2"
                >
                  {SUPPORT_EMAIL}
                </a>{' '}
                is read by a person.
              </p>
            </div>
          ) : (
            <form
              className="mt-10"
              onSubmit={async (e) => {
                e.preventDefault()
                setBusy(true)
                try {
                  await fetch('/api/orders/resend', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                  })
                } catch {
                  // Deliberately ignored. The answer a visitor sees must not
                  // depend on what happened — including on whether the request
                  // arrived at all, which would otherwise be one more signal.
                }
                setBusy(false)
                setDone(true)
              }}
            >
              <Label htmlFor="resend-email" className="text-xs uppercase tracking-[0.2em] text-white/40">
                Email address
              </Label>
              <Input
                id="resend-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="you@example.com"
                className="mt-3 border-white/15 bg-white/5 text-sm text-white/85 placeholder:text-white/30 focus-visible:ring-violet-300/50"
              />
              <Button
                type="submit"
                size="lg"
                disabled={busy}
                className="mt-6 w-full bg-primary text-primary-foreground hover:bg-violet-300 disabled:opacity-40"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? 'Sending…' : 'Send my link'}
              </Button>
            </form>
          )}
        </div>
      </main>

      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}
