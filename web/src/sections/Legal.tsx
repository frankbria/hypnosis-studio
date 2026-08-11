import { Moon } from 'lucide-react'
import { DISCLAIMER } from '@/lib/data'
import {
  DATA_WE_KEEP,
  DELIVERED_GOODS_NOTICE,
  NO_ACCOUNT_NOTICE,
  NO_TRACKING_NOTICE,
  RENDER_FAILURE_GUARANTEE,
  RETENTION_WINDOW,
  SUPPORT_EMAIL,
} from '@/lib/legal'
import SiteFooter from '@/components/SiteFooter'

export type LegalPageId = 'terms' | 'privacy' | 'refunds'

function Shell({
  title,
  intro,
  onHome,
  children,
}: {
  title: string
  intro: string
  onHome: () => void
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-[#0d0b14]">
      <header className="px-6 pt-10">
        <button
          type="button"
          onClick={onHome}
          className="mx-auto flex max-w-2xl items-center gap-3 text-white/70 transition-colors hover:text-white"
        >
          <Moon className="size-4 text-violet-300/70" />
          <span className="text-xs font-medium tracking-[0.3em]">
            HYPNOSIS&nbsp;STUDIO
          </span>
        </button>
      </header>

      <main className="px-6 py-14">
        <article className="mx-auto max-w-2xl">
          <h1 className="font-display text-4xl leading-tight text-[#e8e6f0]">{title}</h1>
          <p className="mt-5 text-sm leading-relaxed text-white/60">{intro}</p>
          <div className="mt-10 space-y-9">{children}</div>
        </article>
      </main>

      <SiteFooter onHome={onHome} />
    </div>
  )
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium uppercase tracking-[0.15em] text-white/70">
        {heading}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-white/55">{children}</div>
    </section>
  )
}

export function TermsPage({ onHome }: { onHome: () => void }) {
  return (
    <Shell
      title="Terms of use"
      intro="Plain terms for a small product. If something here is unclear, ask before you buy."
      onHome={onHome}
    >
      <Section heading="What you are buying">
        <p>
          A four-track self-hypnosis program, delivered as studio-mastered audio in
          WAV and MP3. You choose the program and the voice; the tracks are
          produced by an automated audio pipeline.
        </p>
        <p>
          Track lengths shown before purchase are minimums. Your tracks will be at
          least that long and are usually somewhat longer.
        </p>
      </Section>

      <Section heading="How long you can download it">
        <p>
          Your files stay available for <strong className="text-white/75">{RETENTION_WINDOW}</strong>{' '}
          after your render finishes, then they are deleted automatically. Download
          them and keep your own copy — we do not hold a backup for you, and once
          they are gone we cannot recover them.
        </p>
        <p>
          The audio is yours to keep and listen to privately for as long as you
          like. The {RETENTION_WINDOW} applies to how long we host the files, not
          to your use of them.
        </p>
      </Section>

      <Section heading="If a render fails">
        <p>
          Rendering takes fifteen to twenty minutes and occasionally fails. If it
          does, you will see it on the page — the site never reports a program as
          ready unless it is.
        </p>
        {/* This section described the failure and stopped there, which left the
            terms silent on the money. The guarantee has one home; the terms
            point at it rather than restating it in words that could drift. */}
        <p className="text-white/75">{RENDER_FAILURE_GUARANTEE}</p>
      </Section>

      <Section heading="This is not medical or psychological care">
        <p>{DISCLAIMER}</p>
      </Section>

      <Section heading="Changes">
        <p>
          If these terms change, the version on this page is the one that applies
          to purchases made after it appears.
        </p>
      </Section>
    </Shell>
  )
}

export function RefundPage({ onHome }: { onHome: () => void }) {
  return (
    <Shell
      title="Refunds"
      intro="One rule that matters: if the render fails, you get your money back without asking."
      onHome={onHome}
    >
      <Section heading="If your render fails">
        <p className="text-white/75">{RENDER_FAILURE_GUARANTEE}</p>
        <p>
          Rendering takes fifteen to twenty minutes and occasionally fails. When it
          does, the failure is ours — you chose a program, paid, and waited for
          nothing. Making you write and ask for the refund would add our problem to
          your day.
        </p>
        <p>
          We do not automatically try again. The studio already retries the parts
          that fail for temporary reasons, so a render that reaches you as failed
          has failed past that point, and a second attempt would likely fail the
          same way. You are refunded, and whether to try again is yours to decide.
        </p>
      </Section>

      <Section heading="If your program renders successfully">
        <p>{DELIVERED_GOODS_NOTICE}</p>
        <p>
          This is the part worth reading before you buy rather than after. Please
          listen to the voice previews and read what each program covers — those
          are there so the decision is made before payment, not regretted after it.
        </p>
        {SUPPORT_EMAIL && (
          <p>
            If something went wrong that is not simply a change of mind, write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-violet-300 underline">
              {SUPPORT_EMAIL}
            </a>{' '}
            and a person will read it.
          </p>
        )}
      </Section>

      <Section heading="Partial failures">
        <p>
          A program is four tracks and is only delivered as a complete set. If some
          tracks render and others do not, that is a failed render and it is
          refunded in full — you are not charged a fraction for a fraction of a
          program.
        </p>
      </Section>

      <Section heading="How the refund reaches you">
        <p>
          It returns to the card you paid with. Your bank decides how quickly it
          appears, which is usually a few days and is not something we control.
        </p>
      </Section>
    </Shell>
  )
}

export function PrivacyPage({ onHome }: { onHome: () => void }) {
  return (
    <Shell
      title="Privacy"
      intro="Short, because there is very little to say. We collect almost nothing."
      onHome={onHome}
    >
      <Section heading="No accounts, no tracking">
        <p>{NO_ACCOUNT_NOTICE}</p>
        <p>{NO_TRACKING_NOTICE}</p>
      </Section>

      <Section heading="What we store, and why">
        <ul className="space-y-3">
          {DATA_WE_KEEP.map((row) => (
            <li key={row.what}>
              <span className="text-white/75">{row.what}</span>
              <span className="text-white/40"> — {row.why}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section heading="How long we keep it">
        <p>
          Everything belonging to a render — the audio and the small records above
          — is deleted automatically{' '}
          <strong className="text-white/75">{RETENTION_WINDOW}</strong> after it
          finishes. There is nothing left to delete afterwards, and nothing to ask
          us to remove.
        </p>
      </Section>

      <Section heading="Who else sees it">
        <p>
          The text of your program is sent to a third-party text-to-speech provider
          to be voiced. Nothing identifying you accompanies it, because we do not
          have anything identifying you.
        </p>
      </Section>

      <Section heading="This is not medical or psychological care">
        <p>{DISCLAIMER}</p>
      </Section>
    </Shell>
  )
}
