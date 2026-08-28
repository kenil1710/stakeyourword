/**
 * Fixture pages: deterministic verification targets for the test suite.
 *
 * The suite needs URLs whose content it controls, so `verify_commitment` can be
 * driven to each verdict on demand instead of against whatever a third-party
 * page happens to say that day. They are deliberately plain — validators fetch
 * them with `web.render(mode="text")`, so only the text matters.
 *
 * These are test infrastructure that happens to be deployed with the app. They
 * are not linked from anywhere in the product.
 */
export const metadata = {
  title: "Fixture",
  robots: { index: false, follow: false },
};

export default function FixtureLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        maxWidth: 640,
        margin: "0 auto",
        padding: 32,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
