export const metadata = {
  title: "Terms of Service — Repli",
};

export default function TermsPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 text-sm leading-7">
      <h1 className="text-2xl font-bold mb-6">Terms of Service</h1>
      <p>
        By using the Repli Service you agree to these terms. The Service connects
        your business messaging accounts to an AI agent that replies to your
        customers on your behalf.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Your responsibilities</h2>
      <ul className="list-disc pl-5 mt-2">
        <li>You must own or manage the business accounts you connect.</li>
        <li>
          Your menus, policies and instructions must be accurate and must not be
          misleading.
        </li>
        <li>
          You remain responsible for the automated replies your agent sends.
        </li>
        <li>
          You must comply with Meta&apos;s platform terms and with all applicable
          laws.
        </li>
      </ul>
      <h2 className="text-lg font-semibold mt-8 mb-2">Service availability</h2>
      <p>
        We provide the Service &quot;as is&quot; and do not guarantee uninterrupted
        availability. We may suspend access in case of abuse, unpaid fees, or a
        violation of these terms.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Termination</h2>
      <p>
        You may stop using the Service at any time by disconnecting your
        accounts. We may terminate access with notice if you violate these terms.
      </p>
      <h2 className="text-lg font-semibold mt-8 mb-2">Liability</h2>
      <p>
        To the maximum extent permitted by law, the Service is not liable for
        indirect or incidental damages arising from use of the Service.
      </p>
      <p className="mt-8 text-gray-500">Last updated: September 2026</p>
    </main>
  );
}