export const dynamic = "force-dynamic";

export default function AuthenticationErrorPage() {
  return (
    <main className="auth-error-page">
      <section>
        <span>ACCESS DENIED</span>
        <h1>ManagerAI could not sign you in.</h1>
        <p>
          This portal is restricted to its configured owner. Try again with the authorized GitHub account, or ask the server owner to verify the authentication configuration.
        </p>
        <form action="/api/auth/signin" method="get">
          <input type="hidden" name="callbackUrl" value="/" />
          <button type="submit">Try GitHub sign-in again</button>
        </form>
      </section>
    </main>
  );
}
