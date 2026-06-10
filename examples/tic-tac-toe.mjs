import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
- register:  agentbus register --pid $PPID <id>
             $PPID inside your Bash tool is your own agent process, so the
             registration dies with you (ctrl-c included) — no stale rows.
             Register exactly ONCE; never re-register.
- receive:   ONLY via await (below). NEVER run "agentbus check-inbox" — it
             silently consumes messages you would then miss.
- await:     agentbus await <id> --timeout-ms 60000
             Prints {"envelopes":[...]}; an empty list just means a timeout,
             await again. Each envelope has id, kind, from, payload.
- reply:     echo '<json>' | agentbus reply <envelope-id> <your-id>
             Only envelopes with kind "ask" can be replied to; the request id
             is the ask envelope's own "id" field.
- ask:       echo '<json>' | agentbus ask <to> --from <your-id> --timeout-ms 120000
             Blocks and prints the reply envelope.
- send:      echo '<json>' | agentbus send <to> --from <your-id>
- publish:   echo '<json>' | agentbus publish --from <your-id>
- unregister: agentbus unregister <id>
Board encoding: a 9-char string, indices 0-8 row-major, "." marks an empty cell.
`;

function moderatorPrompt(ids) {
  return `You are the moderator of a tic-tac-toe game between two agents.
${BUS_RULES}
Your bus id: ${ids.mod}. Player X: ${ids.x}. Player O: ${ids.o}.

Narrate as you go: after every step below (registration done, game started,
each applied move, a timeout/forfeit, game over), publish a single short line:
  echo '{"type":"log","text":"<what just happened>"}' | agentbus publish --from ${ids.mod}
For moves use the form "move 3: X -> 8 | board O.X.X...X".

Run the game:
1. Register yourself, then poll "agentbus ls" (sleep 2 between polls) until
   both players are registered with "alive": true. If a player is still missing
   after 60 seconds,
   abort: report which player never registered instead of starting the game.
2. Start from the empty board ".........". X moves first.
3. Each turn, ask the player whose move it is with payload
   {"type":"your_move","mark":"X","board":"<current board>"}.
   The reply payload contains {"move":<0-8>}.
4. Validate the move (an in-range, empty cell). On an invalid move, re-ask once
   with an "error" field explaining why; a second invalid move forfeits the game.
5. If an ask times out (the ask command reports a timeout error), re-ask once.
   A second consecutive timeout from the same player forfeits the game to the
   other player — do NOT keep retrying beyond that.
6. Apply the move, then check for a win (three in a row) or a draw (full board).
7. When the game ends — including by forfeit — send {"type":"game_over",
   "result":"<X wins|O wins|draw|X wins by forfeit|O wins by forfeit>",
   "board":"<final board>"} to BOTH players, then unregister yourself.

Your final response: the move list in order, the final board drawn as a 3x3
grid, and the result (note a forfeit or abort explicitly).`;
}

function playerPrompt(ids, mark) {
  const self = mark === 'X' ? ids.x : ids.o;
  return `You are a tic-tac-toe player. You play "${mark}".
${BUS_RULES}
Your bus id: ${self}. The moderator is ${ids.mod}.

1. Register yourself once, then loop on await. Keep awaiting through empty
   timeouts, but give up after 10 consecutive empty rounds. Act on EVERY
   envelope await returns; if anything goes wrong mid-loop, just await again —
   never re-register and never run check-inbox.
2. On an ask with payload type "your_move": read the board, choose your
   strongest move (win if you can, otherwise block an opponent win, otherwise
   take the best open square), and reply with {"move":<index>}.
3. On a message with payload type "game_over": unregister yourself and stop.

Your final response: one sentence on how the game went from your side.`;
}

// The moderator publishes {"type":"log"} events; follow the bus event stream
// and surface them through wf.log so the game progresses visibly in the
// runner output. Returns a stop function.
function followModeratorLog(moderatorId, log) {
  const follower = spawn('agentbus', ['events', '--follow', '--kind', 'event']);
  const lines = createInterface({ input: follower.stdout });
  lines.on('line', (line) => {
    try {
      const { envelope } = JSON.parse(line);
      if (envelope.from === moderatorId && envelope.payload.type === 'log') {
        log(envelope.payload.text);
      }
    } catch {
      // non-JSON noise on the stream is not worth failing the game over
    }
  });
  return () => follower.kill();
}

export default async function run(wf) {
  // Inbox files survive unregister and crashes, so a reused game id would let
  // a new game see the previous game's leftover messages.
  const gameId = (wf.args && wf.args.gameId) || Date.now().toString(36);
  // The game needs no heavyweight reasoning, so smaller/faster models keep
  // per-move latency low. Override via
  // --args '{"playerModel":"...","moderatorModel":"..."}'.
  const playerModel = (wf.args && wf.args.playerModel) || 'sonnet';
  const moderatorModel = (wf.args && wf.args.moderatorModel) || 'sonnet';
  const ids = {
    mod: `ttt-${gameId}-mod`,
    x: `ttt-${gameId}-x`,
    o: `ttt-${gameId}-o`,
  };
  const tools = ['Bash'];

  wf.phase('Play');
  wf.log(`game ${gameId}: moderator=${ids.mod} players=${ids.x},${ids.o}`);
  const stopLogFollower = followModeratorLog(ids.mod, wf.log);
  let moderator;
  let playerX;
  let playerO;
  try {
    [moderator, playerX, playerO] = await wf.parallel([
      () => wf.agent(moderatorPrompt(ids), { tools, model: moderatorModel, label: 'moderator' }),
      () => wf.agent(playerPrompt(ids, 'X'), { tools, model: playerModel, label: 'player-x' }),
      () => wf.agent(playerPrompt(ids, 'O'), { tools, model: playerModel, label: 'player-o' }),
    ]);
  } finally {
    stopLogFollower();
  }

  return {
    game: moderator ? moderator.text : null,
    playerX: playerX ? playerX.text : null,
    playerO: playerO ? playerO.text : null,
  };
}
