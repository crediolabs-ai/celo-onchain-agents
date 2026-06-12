// Scene 3: Command — show the actual pnpm dev invocation, 10s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { colors, fonts, sizes, radius } from "../theme";
import { command } from "../data";

export const CommandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOpacity = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Typewriter: reveal characters one by one.
  const charsShown = Math.floor(interpolate(frame, [1.0 * fps, 6.0 * fps], [0, command.length], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  }));
  const displayed = command.slice(0, charsShown);

  // Cursor blinks after typing finishes.
  const typingDone = charsShown >= command.length;
  const cursorBlink = typingDone
    ? Math.floor((frame - 6.0 * fps) / 8) % 2 === 0
    : true;

  // Output hint fades in after typing.
  const hintOpacity = interpolate(frame, [6.5 * fps, 7.5 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg, padding: 80, justifyContent: "center" }}>
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.title, color: colors.accent,
        fontWeight: 800, marginBottom: 40, opacity: headerOpacity,
      }}>
        The fix ↓
      </div>

      {/* Terminal-style code block */}
      <div style={{
        background: colors.codeBg, border: `1px solid ${colors.border}`,
        borderRadius: radius.md, padding: 32, fontFamily: fonts.mono,
        fontSize: 28, color: colors.code, lineHeight: 1.5,
        boxShadow: "0 0 60px rgba(252,255,82,0.06)",
      }}>
        <div style={{ color: colors.textDim, marginBottom: 12, fontSize: 18 }}>~/agent-06 $</div>
        <div style={{ whiteSpace: "pre-wrap" }}>
          {displayed}
          <span style={{ opacity: cursorBlink ? 1 : 0, color: colors.accent }}>▋</span>
        </div>
      </div>

      {/* Output hint */}
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.body, color: colors.textDim,
        marginTop: 40, opacity: hintOpacity, textAlign: "center",
      }}>
        → writes <code style={{ color: colors.accent, fontFamily: fonts.mono }}>agent-06-2025-nigeria-firs.csv</code> + prints markdown summary
      </div>
    </AbsoluteFill>
  );
};
