/**
 * Shell command-substitution / subshell / brace-group extractors.
 *
 * Direct port of the GateGuard `scripts/lib/shell-substitution.js` (510 lines,
 * CommonJS) to ESM TypeScript, logic preserved verbatim — used by the
 * destructive-command detector to peer inside `$(...)`, backticks, `(...)`
 * and `{ ...; }` groups so a destructive command cannot hide inside them.
 *
 * Quote semantics (bash):
 * - Single quotes are literal: `'( ... )'` is a string, not a subshell.
 * - Double quotes are literal for bare parens/braces but still permit `$(...)`.
 */

/** Extract executable command-substitution bodies (`$(...)` and backticks), recursing for nesting. */
export function extractCommandSubstitutions(input: string): string[] {
  const source = String(input || '');
  const substitutions: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];

    if (ch === '\\' && !inSingle) {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle) {
      continue;
    }

    if (ch === '`') {
      let body = '';
      i += 1;
      while (i < source.length) {
        const inner = source[i];
        if (inner === '\\') {
          body += inner;
          if (i + 1 < source.length) {
            body += source[i + 1];
            i += 2;
          } else {
            // Trailing backslash at end of an unterminated span: advance past
            // it so it is not appended a second time by the fallthrough below.
            i += 1;
          }
          continue;
        }
        if (inner === '`') {
          break;
        }
        body += inner;
        i += 1;
      }
      if (body.trim()) {
        substitutions.push(body);
        substitutions.push(...extractCommandSubstitutions(body));
      }
      continue;
    }

    if (ch === '$' && source[i + 1] === '(') {
      let depth = 1;
      let body = '';
      let bodyInSingle = false;
      let bodyInDouble = false;
      i += 2;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !bodyInSingle) {
          body += inner;
          if (i + 1 < source.length) {
            body += source[i + 1];
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inner === "'" && !bodyInDouble && innerPrev !== '\\') {
          bodyInSingle = !bodyInSingle;
        } else if (inner === '"' && !bodyInSingle && innerPrev !== '\\') {
          bodyInDouble = !bodyInDouble;
        } else if (!bodyInSingle && !bodyInDouble) {
          if (inner === '(') {
            depth += 1;
          } else if (inner === ')') {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
        }
        body += inner;
        i += 1;
      }
      if (body.trim()) {
        substitutions.push(body);
        substitutions.push(...extractCommandSubstitutions(body));
      }
    }
  }

  return substitutions;
}

/** Extract bodies of plain `(...)` subshell groups, recursing for nesting. */
export function extractSubshellGroups(input: string): string[] {
  const source = String(input || '');
  const groups: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];

    if (ch === '\\' && !inSingle) {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (ch === '$' && source[i + 1] === '(') {
      let depth = 1;
      let skipInSingle = false;
      let skipInDouble = false;
      i += 2;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !skipInSingle) {
          i += 2;
          continue;
        }
        if (inner === "'" && !skipInDouble && innerPrev !== '\\') {
          skipInSingle = !skipInSingle;
        } else if (inner === '"' && !skipInSingle && innerPrev !== '\\') {
          skipInDouble = !skipInDouble;
        } else if (!skipInSingle && !skipInDouble) {
          if (inner === '(') depth += 1;
          else if (inner === ')') depth -= 1;
        }
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\' && i + 1 < source.length) {
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '(') {
      let depth = 1;
      let body = '';
      let bodyInSingle = false;
      let bodyInDouble = false;
      i += 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !bodyInSingle) {
          body += inner;
          if (i + 1 < source.length) {
            body += source[i + 1];
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inner === "'" && !bodyInDouble && innerPrev !== '\\') {
          bodyInSingle = !bodyInSingle;
        } else if (inner === '"' && !bodyInSingle && innerPrev !== '\\') {
          bodyInDouble = !bodyInDouble;
        } else if (!bodyInSingle && !bodyInDouble) {
          if (inner === '(') {
            depth += 1;
          } else if (inner === ')') {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
        }
        body += inner;
        i += 1;
      }
      if (body.trim()) {
        groups.push(body);
        groups.push(...extractSubshellGroups(body));
      }
    }
  }

  return groups;
}

/**
 * Extract bodies of `{ ...; }` brace groups (bash reserved-word semantics:
 * `{` needs a following whitespace and a preceding boundary; `}` needs a
 * preceding `;` or whitespace). Recurses for nesting.
 */
export function extractBraceGroups(input: string): string[] {
  const source = String(input || '');
  const groups: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];

    if (ch === '\\' && !inSingle) {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (ch === '$' && source[i + 1] === '(') {
      let depth = 1;
      let skipInSingle = false;
      let skipInDouble = false;
      i += 2;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !skipInSingle) {
          i += 2;
          continue;
        }
        if (inner === "'" && !skipInDouble && innerPrev !== '\\') {
          skipInSingle = !skipInSingle;
        } else if (inner === '"' && !skipInSingle && innerPrev !== '\\') {
          skipInDouble = !skipInDouble;
        } else if (!skipInSingle && !skipInDouble) {
          if (inner === '(') depth += 1;
          else if (inner === ')') depth -= 1;
        }
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\' && i + 1 < source.length) {
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '(') {
      let depth = 1;
      let skipInSingle = false;
      let skipInDouble = false;
      i += 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !skipInSingle) {
          i += 2;
          continue;
        }
        if (inner === "'" && !skipInDouble && innerPrev !== '\\') {
          skipInSingle = !skipInSingle;
        } else if (inner === '"' && !skipInSingle && innerPrev !== '\\') {
          skipInDouble = !skipInDouble;
        } else if (!skipInSingle && !skipInDouble) {
          if (inner === '(') depth += 1;
          else if (inner === ')') depth -= 1;
        }
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (ch === '{' && /\s/.test(source[i + 1] || '')) {
      const prevIsBoundary = i === 0 || /[\s;|&(]/.test(prev || '');
      if (!prevIsBoundary) continue;

      let depth = 1;
      let body = '';
      let bodyInSingle = false;
      let bodyInDouble = false;
      i += 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        const innerPrev = source[i - 1];
        if (inner === '\\' && !bodyInSingle) {
          body += inner;
          if (i + 1 < source.length) {
            body += source[i + 1];
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inner === "'" && !bodyInDouble && innerPrev !== '\\') {
          bodyInSingle = !bodyInSingle;
          body += inner;
          i += 1;
          continue;
        }
        if (inner === '"' && !bodyInSingle && innerPrev !== '\\') {
          bodyInDouble = !bodyInDouble;
          body += inner;
          i += 1;
          continue;
        }
        if (bodyInSingle || bodyInDouble) {
          body += inner;
          i += 1;
          continue;
        }
        // Skip $(...) spans — a quoted `}` or `}`-as-text inside a
        // substitution body must not close the enclosing brace group.
        if (inner === '$' && source[i + 1] === '(') {
          body += inner + source[i + 1];
          let subDepth = 1;
          let subInSingle = false;
          let subInDouble = false;
          i += 2;
          while (i < source.length && subDepth > 0) {
            const c = source[i];
            const p = source[i - 1];
            body += c;
            if (c === '\\' && !subInSingle && i + 1 < source.length) {
              body += source[i + 1];
              i += 2;
              continue;
            }
            if (c === "'" && !subInDouble && p !== '\\') subInSingle = !subInSingle;
            else if (c === '"' && !subInSingle && p !== '\\') subInDouble = !subInDouble;
            else if (!subInSingle && !subInDouble) {
              if (c === '(') subDepth += 1;
              else if (c === ')') subDepth -= 1;
            }
            i += 1;
          }
          continue;
        }
        // Skip backtick spans for the same reason.
        if (inner === '`') {
          body += inner;
          i += 1;
          while (i < source.length && source[i] !== '`') {
            if (source[i] === '\\' && i + 1 < source.length) {
              body += (source[i] ?? '') + (source[i + 1] ?? '');
              i += 2;
              continue;
            }
            body += source[i];
            i += 1;
          }
          if (i < source.length) {
            body += source[i];
            i += 1;
          }
          continue;
        }
        // Skip plain (...) subshell spans for the same reason.
        if (inner === '(') {
          body += inner;
          let subDepth = 1;
          let subInSingle = false;
          let subInDouble = false;
          i += 1;
          while (i < source.length && subDepth > 0) {
            const c = source[i];
            const p = source[i - 1];
            body += c;
            if (c === '\\' && !subInSingle && i + 1 < source.length) {
              body += source[i + 1];
              i += 2;
              continue;
            }
            if (c === "'" && !subInDouble && p !== '\\') subInSingle = !subInSingle;
            else if (c === '"' && !subInSingle && p !== '\\') subInDouble = !subInDouble;
            else if (!subInSingle && !subInDouble) {
              if (c === '(') subDepth += 1;
              else if (c === ')') subDepth -= 1;
            }
            i += 1;
          }
          continue;
        }
        if (inner === '{' && /\s/.test(source[i + 1] || '')) {
          // Match the outer-scan boundary rule for nested `{` so
          // tokens like `foo{` (no boundary, but followed by space
          // via `foo{ bar`) cannot bump nested depth.
          const nestedPrevIsBoundary = /[\s;|&(]/.test(innerPrev || '');
          if (nestedPrevIsBoundary) depth += 1;
        } else if (inner === '}' && (innerPrev === ';' || /\s/.test(innerPrev || ''))) {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
        body += inner;
        i += 1;
      }
      if (body.trim()) {
        groups.push(body);
        groups.push(...extractBraceGroups(body));
      }
    }
  }

  return groups;
}
