export const meta = {
  name: 'fanout',
  description: 'Ask one agent per topic in parallel and collect the answers',
};

export default async function run(wf) {
  const topics = (wf.args && wf.args.topics) || ['sky', 'grass'];
  const answers = await wf.parallel(
    topics.map((t) => () => wf.agent(`What color is ${t}? Reply with one word.`)),
  );
  return answers.map((a, i) => ({ topic: topics[i], answer: a ? a.text : null }));
}
