#!/usr/bin/env python3
"""Decide whether a Refresh-songs failure is news or a repeat.

2026-08-23, from the yswords queue: the workflow has failed every day
since 08-12 with the identical guard message (cdc withholding audio on
~39 song pages), and "six identical mails teach the reader to ignore
the seventh, which is the one that will say something new."

The GUARD IS CORRECT and is not touched: refusing to publish a
catalogue that lost a tenth of its audio is the right outcome. What
changes is only whether the workflow's exit code — and therefore
GitHub's failure email — repeats it.

Rules, exactly as specified in the queue item:
  * reason unchanged from the previous failure  -> exit 0 (no email),
    unless the same reason has now persisted PAST_DUE days — by then
    it is news again, not noise.
  * reason changed, or first failure            -> exit 1 (email).

State lives in .github/refresh-songs-state.json, committed by this
script. In-repo rather than an Actions cache because cache entries are
evicted after ~7 idle days, which is precisely the horizon this state
must survive. The success path deletes the file (see the workflow), so
a stale state cannot bridge across an intervening good run.
"""

import datetime as dt
import json
import pathlib
import re
import subprocess
import sys

STATE = pathlib.Path('.github/refresh-songs-state.json')
PAST_DUE_DAYS = 7


def reason_from(stderr_text: str) -> str:
    """The guard's one-line reason, counts stripped.

    "cdc: 286 -> 247 with audio" must equal tomorrow's
    "cdc: 286 -> 245 with audio": the wobble in how many pages answered
    is not a new failure, and comparing it raw would re-alert daily —
    the exact noise this script exists to stop. The SOURCE and the KIND
    of guard are the identity; the numbers are the weather.
    """
    lines = [l.strip() for l in stderr_text.splitlines()]
    kind = next((l for l in lines if l.startswith('ERROR:')), None)
    detail = next((l for l in lines if '→' in l or '->' in l), '')
    if kind is None:
        # Not a guard refusal — an infrastructure error (timeout, bad
        # JSON, runner failure). Always news.
        return ''
    detail = re.sub(r'\d+', 'N', detail)
    return f'{kind} | {detail}'


def git(*args):
    return subprocess.run(['git', *args], check=False,
                          capture_output=True, text=True)


def commit_state(state: dict):
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2) + '\n')
    git('add', str(STATE))
    if git('diff', '--cached', '--quiet').returncode == 0:
        return
    git('-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'chore: refresh-songs failure state')
    # The hourly news cron can land between checkout and here; the
    # state file is ours alone, so rebasing over the remote is always
    # the right resolution.
    if git('push').returncode != 0:
        git('pull', '--rebase', 'origin', 'main')
        git('push')


def main() -> int:
    stderr_text = pathlib.Path(sys.argv[1]).read_text() \
        if len(sys.argv) > 1 and pathlib.Path(sys.argv[1]).exists() else ''
    reason = reason_from(stderr_text)
    today = dt.date.today().isoformat()

    if not reason:
        print('failure is not a guard refusal — always news; failing loudly')
        return 1

    prev = {}
    if STATE.exists():
        try:
            prev = json.loads(STATE.read_text())
        except (json.JSONDecodeError, OSError):
            prev = {}

    if prev.get('reason') != reason:
        commit_state({'reason': reason, 'first_seen': today,
                      'last_seen': today})
        print(f'NEW failure reason — failing loudly:\n  {reason}')
        return 1

    first = dt.date.fromisoformat(prev.get('first_seen', today))
    days = (dt.date.today() - first).days
    commit_state({'reason': reason, 'first_seen': first.isoformat(),
                  'last_seen': today})
    if days >= PAST_DUE_DAYS:
        print(f'same reason for {days} days — past due, failing loudly '
              f'so it reads as news again:\n  {reason}')
        # Reset the clock so the NEXT reminder is another week out,
        # not tomorrow.
        commit_state({'reason': reason, 'first_seen': today,
                      'last_seen': today})
        return 1

    print(f'repeat of a known failure (day {days + 1}, reminder at day '
          f'{PAST_DUE_DAYS}) — suppressing the email:\n  {reason}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
