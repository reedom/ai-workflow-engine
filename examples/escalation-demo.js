// examples/escalation-demo.js
// Demo: the agent is only granted Read, then asked to use Bash — the Bash
// call escalates to a human over agentbus. Run with:
//   pnpm build
//   agentbus register me --persistent   # once
//   node dist/cli.js run examples/escalation-demo.js --escalate agentbus:me
// Answer from another shell:
//   agentbus check-inbox me                                   # note the ask's "id"
//   echo '{"behavior":"allow"}' | agentbus reply <msg-id> me  # approve it
export const meta = {
  name: 'escalation-demo',
  description: 'demo: an agent needs a tool outside its grants',
};

export default async function (wf) {
  const result = await wf.agent(
    'Run the Bash command `whoami` and then reply with exactly one word: done if it ran, blocked if it was not permitted.',
    { tools: ['Read'], label: 'demo-worker', escalation: { timeoutMs: 120_000 } },
  );
  wf.log(`agent said: ${result.text}`);
  return result.text;
}
