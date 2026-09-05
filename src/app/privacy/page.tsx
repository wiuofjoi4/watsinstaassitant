export const metadata = {
  title: "Privacy Policy — Repli",
};

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 text-sm leading-7">
      <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>
      <p>
        Repli (the&nbsp;&quot;Service&quot;) lets restaurant owners connect their
        WhatsApp and Instagram business accounts so that a trained AI agent can
        answer customer messages on their behalf.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Data we process</h2>
      <p>
        When you connect a business account, we store your account identifier,
        display name and the access tokens required to send and receive messages.
        Incoming customer conversations (text, voice and image messages) are kept
        so that the agent and the restaurant owner can review them. No payment
        cards or personal identity data are collected.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">How we use data</h2>
      <p>
        Message content is used only to generate automated replies and for the
        restaurant owner to review conversations through the dashboard. AI
        replies are produced by a third-party language model provider; only the
        specific message text needed for a reply is sent to that provider.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Sharing</h2>
      <p>
        We do not sell or rent your data. We share data only with the services
        required to operate the Service (Meta platforms, the AI provider, and
        our database host), under their respective policies.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Data retention</h2>
      <p>
        Conversations and access tokens are kept while your account is active
        and are permanently deleted when you disconnect your accounts or delete
        the restaurant profile.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Contact</h2>
      <p>
        To exercise any privacy right, stop processing, or ask a question, email
        the operator of this Service or use the user-data deletion endpoint
        listed in the Delete Data page.
      </p>
      <p className="mt-8 text-gray-500">
        Last updated: September 2026
      </p>
    </main>
  );
}