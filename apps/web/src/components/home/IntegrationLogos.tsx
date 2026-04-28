/**
 * IntegrationLogos — row of real AI-app logos shown under the hero input.
 * No fabricated marks: every SVG here is either a Simple Icons path or a
 * restrained typographic badge. Claude + ChatGPT + Cursor are the
 * first-class clients; "+ more" pill acknowledges that Floom works with
 * any AI app that speaks the open MCP protocol.
 *
 * 2026-04-19 UX pass: removed the inline "any MCP client" Link so the
 * hero only has two CTAs (Publish your app / Browse live apps). The
 * third underlined link was reading as a 3rd button above the fold.
 */

interface LogoProps {
  title: string;
  children: React.ReactNode;
}

function LogoChip({ title, children }: LogoProps) {
  // role="img" makes aria-label valid on this non-interactive container.
  // Without the role, axe-core flags aria-label on a span as prohibited.
  return (
    <span
      role="img"
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        color: 'var(--muted)',
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

interface IntegrationLogosProps {
  /**
   * Suppress the outer block spacing + "Works with" caption when the
   * parent already provides the label (e.g. the hero "WORKS WITH" row).
   */
  variant?: 'block' | 'inline';
}

export function IntegrationLogos({ variant = 'block' }: IntegrationLogosProps = {}) {
  const inline = variant === 'inline';
  return (
    <div
      data-testid="integration-logos"
      className="integration-logos"
      style={{
        marginTop: inline ? 0 : 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: inline ? 12 : 18,
        flexWrap: 'wrap',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: inline ? 10 : 14 }}>
        {/* Claude — simpleicons `anthropic` path */}
        <LogoChip title="Claude (Anthropic)">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M4.709 15.955l4.72-2.647.079-.23-.079-.128h-.23l-.785-.048-2.683-.072-2.325-.097-2.254-.121-.567-.121L0 11.762l.056-.36.482-.325.69.061 1.527.104 2.29.158 1.66.097 2.46.256h.39l.055-.16-.134-.098-.104-.097-2.373-1.608-2.567-1.698-1.345-.978-.727-.494-.365-.464-.158-1.013.658-.724.885.06.225.061.897.69 1.915 1.48 2.498 1.838.365.304.146-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.62a2.97 2.97 0 01-.104-.729L6.64.131 7.038 0l.96.13.404.35.597 1.365.967 2.15 1.504 2.93.44.87.234.81.088.248h.152V7.84l.123-1.64.228-2.014.225-2.593.075-.73.357-.86.708-.467.553.263.454.65-.06.424-.29 1.874-.568 2.941-.371 1.967h.216l.247-.246 1-1.328 1.681-2.1.725-.82.846-.902.543-.434h1.028l.756 1.123-.339 1.168-1.056 1.34-.878 1.139-1.26 1.692-.787 1.358.073.109.188-.019 2.853-.606 1.542-.278 1.838-.316.828.388.09.393-.326.808-1.955.483-2.299.46-3.418.811-.043.03.051.063 1.537.145.661.038h1.62l3.01.226.787.52.474.638-.081.484-1.215.62-1.64-.39-3.829-.911-1.314-.328h-.182v.11l1.096 1.07 2.005 1.81 2.517 2.343.128.582-.324.454-.343-.048-2.233-1.673-.864-.758-1.95-1.639h-.129v.173l.451.657 2.381 3.581.122 1.099-.17.358-.617.214-.674-.124-1.395-1.966-1.437-2.2-1.159-1.974-.142.082-.686 7.371-.321.379-.738.282-.613-.468-.327-.759.327-1.494.396-1.951.324-1.555.292-1.933.174-.642-.012-.042-.141.018-1.463 2.008-2.223 3.005-1.758 1.886-.419.168-.728-.375.068-.675.407-.6 2.418-3.077.738-.94.844-1.172.026-.223v-.099l-.15-.014z"/>
          </svg>
        </LogoChip>
        {/* ChatGPT / OpenAI — simpleicons `openai` path */}
        <LogoChip title="ChatGPT (OpenAI)">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
          </svg>
        </LogoChip>
        {/* Cursor — geometric C mark (brand is a glyph, not a trademarked SVG) */}
        <LogoChip title="Cursor">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M11.925 24l10.425-6.01V5.98L11.925 0 1.5 5.98v12.01L11.925 24zm0-2.32l-8.4-4.85V7.17l8.4 4.86v9.65zm.9-9.65l8.4-4.86v9.66l-8.4 4.85v-9.65zm-.45-1.56L3.975 5.63l8.4-4.85 8.4 4.85-8.4 4.84z"
            />
          </svg>
        </LogoChip>
        {/* MCP glyph — the protocol logo is a simple hex/dot; keep it as
             a plain geometric badge so we never misrepresent the logo. */}
        <LogoChip title="And more">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="currentColor" />
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" />
          </svg>
        </LogoChip>
      </div>
      {!inline && (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          Works with any MCP client.
        </span>
      )}
    </div>
  );
}
