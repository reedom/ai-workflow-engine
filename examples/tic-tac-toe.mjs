export const meta = {
  name: 'tic-tac-toe',
  description:
    'Three agents play tic-tac-toe: a moderator runs the game and two players ' +
    'pick moves, all coordinating over the agentbus CLI',
  whenToUse: 'Demo of inter-agent messaging (agentbus) instead of JS data flow',
  phases: [{ title: 'Play', detail: 'moderator + two players, concurrently' }],
};

// All three agents run concurrently and talk through agentbus inboxes:
//   moderator --ask--> player (payload {type:"your_move", board, mark})
//   player    --reply-> moderator (payload {move: 0-8})
//   moderator --send--> players (payload {type:"game_over", ...})
// Requires the `agentbus` CLI on PATH (https://github.com/reedom/agentbus).

const BUS_RULES = `
agentbus cheat sheet (run via Bash):
- register:  agentbus register --persistent <id>
- await:     agentbus await <id> --timeout-ms 60000
             Prints {"envelopes":[...]}; an empty list just means a timeout,
             await again. Each envelope has id, kind, from, payload.
- reply:     echo '<json>' | agentbus reply <envelope-id> <your-id>
             Only envelopes with kind "ask" can be replied to; the request id
             is the ask envelope's own "id" field.
- ask:       echo '<json>' | agentbus ask <to> --from <your-id> --timeout-ms 120000
             Blocks and prints the reply envelope.
- send:      echo '<json>' | agentbus send <to> --from <your-id>
- unregister: agentbus unregister <id>
Board encoding: a 9-char string, indices 0-8 row-major, "." marks an empty cell.
`;

function moderatorPrompt(ids) {
  return `You are the moderator of a tic-tac-toe game between two agents.
${BUS_RULES}
Your bus id: ${ids.mod}. Player X: ${ids.x}. Player O: ${ids.o}.

Run the game:
1. Register yourself, then poll "agentbus ls" (sleep 2 between polls) until
   both players are registered.
2. Start from the empty board ".........". X moves first.
3. Each turn, ask the player whose move it is with payload
   {"type":"your_move","mark":"X","board":"<current board>"}.
   The reply payload contains {"move":<0-8>}.
4. Validate the move (an in-range, empty cell). On an invalid move, re-ask once
   with an "error" field explaining why; a second invalid move forfeits the game.
5. Apply the move, then check for a win (three in a row) or a draw (full board).
6. When the game ends, send {"type":"game_over","result":"<X wins|O wins|draw>",
   "board":"<final board>"} to BOTH players, then unregister yourself.

Your final response: the move list in order, the final board drawn as a 3x3
grid, and the result.`;
}

function playerPrompt(ids, mark) {
  const self = mark === 'X' ? ids.x : ids.o;
  return `You are a tic-tac-toe player. You play "${mark}".
${BUS_RULES}
Your bus id: ${self}. The moderator is ${ids.mod}.

1. Register yourself, then loop on await. Keep awaiting through empty timeouts,
   but give up after 10 consecutive empty rounds.
2. On an ask with payload type "your_move": read the board, choose your
   strongest move (win if you can, otherwise block an opponent win, otherwise
   take the best open square), and reply with {"move":<index>}.
3. On a message with payload type "game_over": unregister yourself and stop.

Your final response: one sentence on how the game went from your side.`;
}

export default async function run(wf) {
  const gameId = (wf.args && wf.args.gameId) || 'demo';
  const ids = {
    mod: `ttt-${gameId}-mod`,
    x: `ttt-${gameId}-x`,
    o: `ttt-${gameId}-o`,
  };
  const tools = ['Bash'];

  wf.phase('Play');
  wf.log(`game ${gameId}: moderator=${ids.mod} players=${ids.x},${ids.o}`);
  const [moderator, playerX, playerO] = await wf.parallel([
    () => wf.agent(moderatorPrompt(ids), { tools, label: 'moderator' }),
    () => wf.agent(playerPrompt(ids, 'X'), { tools, label: 'player-x' }),
    () => wf.agent(playerPrompt(ids, 'O'), { tools, label: 'player-o' }),
  ]);

  return {
    game: moderator ? moderator.text : null,
    playerX: playerX ? playerX.text : null,
    playerO: playerO ? playerO.text : null,
  };
}
