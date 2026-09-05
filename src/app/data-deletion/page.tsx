export const metadata = {
  title: "Delete Data — Repli",
};

export default function DataDeletionPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 text-sm leading-7">
      <h1 className="text-2xl font-bold mb-6">User Data Deletion</h1>
      <p>
        You can request deletion of all data we hold about your account at any
        time. This removes connected account identifiers, access tokens, and all
        stored conversations permanently.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Request by email</h2>
      <p>
        Send an email to the operator of this Service from the email address you
        used to sign up, with the subject &quot;Delete my data&quot; and stating
        the restaurant / business name. We will confirm the deletion.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">What is deleted?</h2>
      <ul className="list-disc pl-5 mt-2">
        <li>Connected WhatsApp and Instagram account identifiers</li>
        <li>Access tokens (the platform connection is revoked)</li>
        <li>All conversation history and AI usage logs</li>
      </ul>
      <p>
        Deletion is performed within 30 days of a completed, verified request.
      </p>
      <p className="mt-8 text-gray-500">
        Related: <a href="/privacy">Privacy Policy</a> ·{" "}
        <a href="/terms">Terms of Service</a>
      </p>
    </main>
  );
}