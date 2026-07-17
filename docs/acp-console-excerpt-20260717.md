[ACP console excerpt 2026-07-17 ~09:27-09:32, pasted by Jon in BAPert session]
Key sequence (abridged from paste):
[ACP BAPert] >>> session/prompt id=23 (mail 11384 injection)
stderr: Error handling request {id:23, method:session/prompt} {code:-32600, message:'Invalid request: Cannot launch a new turn while another turn (ID 20) is active', data:{code:'turn.agent_busy', details:{turnId:20}}}
[ACP process] <<< error id=23 (session/prompt): ... turn (ID 20) is active (code -32600)
[ACP BAPert] session/prompt failed ... turn.agent_busy
[ACP BAPert] cancelling failed turn; keeping session session_9d80a71b...
[later] id=24..27 session/prompt all complete stopReason=end_turn
User prompts "cool thx"/"awesome sauce" -> prompt queued (queueDepth=1..3) -> drain promptly on turn completion
DotNetPert/NextPert/QAPert tool_call notifications flow continuously (permissions auto-answered fine)
No watchdog "No response from..." lines anywhere in excerpt
Renderer noise: "ReferenceError: dragEvent is not defined" x2
