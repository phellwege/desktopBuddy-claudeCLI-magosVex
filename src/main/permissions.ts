// Session-scoped remembered tool allows (spec 6.4.1). "Allow this session" on the permission
// card answers that one request allowed and remembers the tool name; later requests for the
// same tool name are answered allowed without ever showing a card or posting a line. Cleared
// on /new and /cd (a new CLI session) and on app exit - main/index.ts owns the instance and
// the clearing rule, this module is just the set.
export class SessionAllows {
  private readonly tools = new Set<string>()

  allows(toolName: string): boolean {
    return this.tools.has(toolName)
  }

  remember(toolName: string): void {
    this.tools.add(toolName)
  }

  clear(): void {
    this.tools.clear()
  }
}
