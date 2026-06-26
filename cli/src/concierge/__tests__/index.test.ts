import { describe, it, expect } from 'vitest'
import { classifyMessage } from '../index.js'

describe('classifyMessage', () => {
  it('returns "task" for a plain action request', () => {
    expect(classifyMessage('Book me a table at 7pm')).toBe('task')
    expect(classifyMessage('Send an email to john')).toBe('task')
    expect(classifyMessage('What is the capital of France?')).toBe('task')
    expect(classifyMessage('Open my calendar')).toBe('task')
  })

  it('returns "context" for "you said/mentioned/explained/wrote" patterns', () => {
    expect(classifyMessage('You said you would book it')).toBe('context')
    expect(classifyMessage('you mentioned something about the meeting')).toBe('context')
    expect(classifyMessage('You explained the process earlier')).toBe('context')
    expect(classifyMessage('you wrote a script for that')).toBe('context')
  })

  it('returns "context" for "you created/built/found/showed" patterns', () => {
    expect(classifyMessage('you created a workflow for me')).toBe('context')
    expect(classifyMessage('you built that last week')).toBe('context')
    expect(classifyMessage('you found the file')).toBe('context')
    expect(classifyMessage('you showed me the results')).toBe('context')
  })

  it('returns "context" for "last time / previous / earlier" patterns', () => {
    expect(classifyMessage('What did we do last time?')).toBe('context')
    expect(classifyMessage('previously you helped me with taxes')).toBe('context')
    expect(classifyMessage('earlier today you ran a search')).toBe('context')
    expect(classifyMessage('before today we covered this')).toBe('context')
  })

  it('returns "context" for recap/history request patterns', () => {
    expect(classifyMessage('Remind me what happened')).toBe('context')
    expect(classifyMessage("Can you recap what we've done?")).toBe('context')
    expect(classifyMessage('summarize our conversation')).toBe('context')
    expect(classifyMessage('show me the conversation history')).toBe('context')
    expect(classifyMessage('what is in our chat history?')).toBe('context')
  })

  it('returns "context" for temporal past references', () => {
    expect(classifyMessage('What did we do yesterday?')).toBe('context')
    expect(classifyMessage('last week you helped me')).toBe('context')
    expect(classifyMessage('I asked about this last month')).toBe('context')
  })

  it('returns "context" for "what did you/we" construction', () => {
    expect(classifyMessage('What did you book last time?')).toBe('context')
    expect(classifyMessage('what were we talking about?')).toBe('context')
    expect(classifyMessage('what have you done so far?')).toBe('context')
    expect(classifyMessage('what was Sai working on?')).toBe('context')
  })

  it('returns "context" for "what was/is the last / show me the last" patterns', () => {
    expect(classifyMessage('show me the last message')).toBe('context')
    expect(classifyMessage('what the last task you ran')).toBe('context')
    expect(classifyMessage('what was the last thing you did?')).toBe('context')
    expect(classifyMessage("what's the last task you ran?")).toBe('context')
    expect(classifyMessage('what is the last file you opened?')).toBe('context')
    expect(classifyMessage('what were the last steps you took?')).toBe('context')
  })

  it('returns "context" for "when did we / how many times did" patterns', () => {
    expect(classifyMessage('when did we last talk about budgets?')).toBe('context')
    expect(classifyMessage('how many times did you run that script?')).toBe('context')
    expect(classifyMessage('when did Sai finish the task?')).toBe('context')
  })

  it('is case-insensitive', () => {
    expect(classifyMessage('YOU SAID something earlier')).toBe('context')
    expect(classifyMessage('LAST WEEK we did X')).toBe('context')
    expect(classifyMessage('REMIND ME what happened')).toBe('context')
  })

  it('returns "context" for "did you / have you" patterns', () => {
    expect(classifyMessage('did you send that email?')).toBe('context')
    expect(classifyMessage('did you finish the task?')).toBe('context')
    expect(classifyMessage('have you done it yet?')).toBe('context')
    expect(classifyMessage('have you already run that script?')).toBe('context')
  })

  it('returns "context" for "I asked/told you" patterns', () => {
    expect(classifyMessage('I asked you to book a table')).toBe('context')
    expect(classifyMessage('I told you to send the report')).toBe('context')
    expect(classifyMessage('I asked Sai to fix the bug')).toBe('context')
  })

  it('returns "context" for "what happened with/to" patterns', () => {
    expect(classifyMessage('what happened with the file upload?')).toBe('context')
    expect(classifyMessage('what happened to the email I asked you to send?')).toBe('context')
  })

  it('returns "context" for "are you still/done/finished" patterns', () => {
    expect(classifyMessage('are you still working on that?')).toBe('context')
    expect(classifyMessage('are you done with the search?')).toBe('context')
    expect(classifyMessage('are you finished?')).toBe('context')
  })

  it('defaults to "task" for ambiguous or empty-ish inputs', () => {
    expect(classifyMessage('hello')).toBe('task')
    expect(classifyMessage('write me a haiku')).toBe('task')
    expect(classifyMessage('last')).toBe('task') // bare word without context verb
  })

  it('task override: "go back to" continuation phrases are always tasks', () => {
    expect(classifyMessage('go back to my earlier task about the videos')).toBe('task')
    expect(classifyMessage('go back to what we were doing')).toBe('task')
    expect(classifyMessage('continue the work on the spreadsheet')).toBe('task')
    expect(classifyMessage('continue with the email sorting')).toBe('task')
    expect(classifyMessage('resume the task from before')).toBe('task')
    expect(classifyMessage('resume where we left off')).toBe('task')
    expect(classifyMessage('pick up where you left off')).toBe('task')
    expect(classifyMessage('carry on with the analysis')).toBe('task')
  })

  it('"earlier" requires a qualifier to be classified as context', () => {
    // With qualifier → context
    expect(classifyMessage('earlier today you ran a search')).toBe('context')
    expect(classifyMessage('earlier session you helped me')).toBe('context')
    expect(classifyMessage('earlier conversation we covered this')).toBe('context')
    // Without qualifier → task (no longer matches)
    expect(classifyMessage('go back to my earlier task')).toBe('task')
    expect(classifyMessage('continue the earlier work')).toBe('task')
  })
})
