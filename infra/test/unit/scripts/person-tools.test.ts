import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The personal-login tools in scripts/ops/:
 *
 *   person-login.sh   create | renew | remove a personal database login. The
 *                     person runs it with their own AWS identity; only the
 *                     SCRAM verifier of an AWS-generated password reaches the
 *                     ops host, where the master login runs jale_ops.
 *                     provision_person / renew_person / remove_person.
 *   person-psql.sh    the person's own secret, a Session Manager port forward
 *                     through the ops host, and local psql 16 or newer.
 *   person-lookup.sh  a hidden prompt, then jale_ops.find_user with the value
 *                     as a bound parameter, printing the id only.
 *
 * The static checks pin the shape. The harness runs the real scripts against
 * a fake AWS CLI (which enforces each secret's resource policy against the
 * caller), a fake ops host that plays the three procedures, and a fake local
 * psql; every other tool is a recording wrapper, so "never in argv" is checked
 * against what actually ran.
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const opsDir = path.join(repoRoot, 'scripts', 'ops');
const TOOLS = ['person-login.sh', 'person-psql.sh', 'person-lookup.sh'] as const;

function readTool(name: string): string {
  return fs.readFileSync(path.join(opsDir, name), 'utf8');
}

/** The handle rule jale_ops.provision_person enforces (migration 112). */
const DB_HANDLE_RULE = /^[a-z][a-z0-9]{1,15}$/;
/** The secret names the audit sentinel treats as personal. */
const SENTINEL_PERSONAL_SECRET = /^jale\/person-[a-z0-9]+(-[a-z0-9]+)*\/db$/;
const HANDLE_SAMPLES = ['ab', 'abcd', 'wxyz2', 'a1b2c3d4e5f6g7h8', 'a', 'a1b2c3d4e5f6g7h8i', '9abc', 'Ab', 'a-b', 'a_b', 'ab ', "a'b", 'abé', ''];

/** Lines of a script that are not comments. */
function code(text: string): string {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

function definition(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm'))?.[0];
}

describe('scripts/ops person tools (static)', () => {
  it('share one handle rule, the one provision_person enforces, in the C locale', () => {
    const defs = TOOLS.map((t) => definition(readTool(t), 'is_person_handle'));
    for (const d of defs) expect(d).toBe(defs[0]);
    expect(defs[0]).toContain('local LC_ALL=C;');
    for (const locale of ['C.UTF-8', 'en_US.UTF-8']) {
      for (const sample of HANDLE_SAMPLES) {
        const r = spawnSync('bash', ['-c', `${defs[0]}\nis_person_handle "$1"`, 'rule', sample], {
          encoding: 'utf8', env: { ...process.env, LC_ALL: locale },
        });
        expect({ locale, sample, accepted: r.status === 0 }).toEqual({ locale, sample, accepted: DB_HANDLE_RULE.test(sample) });
      }
    }
  });

  it('derive the login and the secret name the same way, and every secret name is one the sentinel treats as personal', () => {
    const login = TOOLS.slice(0, 2).map((t) => definition(readTool(t), 'person_login'));
    const secret = TOOLS.slice(0, 2).map((t) => definition(readTool(t), 'person_secret_name'));
    expect(login[1]).toBe(login[0]);
    expect(secret[1]).toBe(secret[0]);
    for (const handle of HANDLE_SAMPLES.filter((s) => DB_HANDLE_RULE.test(s))) {
      const out = execFileSync('bash', ['-c', `${login[0]}\n${secret[0]}\nperson_login "$1"; echo; person_secret_name "$1"`, 'x', handle], { encoding: 'utf8' });
      const [l, s] = out.split('\n');
      expect(l).toBe(`jale_person_${handle}`);
      expect(s).toBe(`jale/person-${handle}/db`);
      expect(s).toMatch(SENTINEL_PERSONAL_SECRET);
    }
  });

  it('ask AWS for every password: 40 characters, no punctuation, every character type', () => {
    const login = readTool('person-login.sh');
    expect(login).toMatch(/^PASSWORD_LENGTH=40$/m);
    expect(login).toContain('aws secretsmanager get-random-password --region "$REGION" --password-length "$PASSWORD_LENGTH" \\\n         --exclude-punctuation --require-each-included-type');
    // Nothing else makes a password.
    for (const t of TOOLS) expect(code(readTool(t))).not.toMatch(/openssl|\/dev\/urandom|\$RANDOM|uuidgen/);
  });

  it('never put a password, a verifier, a lookup value or a secret value in argv', () => {
    const login = code(readTool('person-login.sh'));
    const psql = code(readTool('person-psql.sh'));
    const lookup = code(readTool('person-lookup.sh'));
    for (const text of [login, psql, lookup]) {
      expect(text).not.toMatch(/--secret-string/);
      expect(text).not.toMatch(/--password(?![-\w])/);
      expect(text).not.toMatch(/--arg\s+\w+\s+"\$(PW|VERIFIER|VALUE|SECRET_JSON)"/);
    }
    // The password goes into the secret on the CLI's stdin, and to psql only
    // through its environment.
    expect(login).toContain('printf \'%s\' "$PW" | jq -Rs');
    expect(login).toContain('aws secretsmanager put-secret-value --region "$REGION" --cli-input-json file:///dev/stdin');
    expect(psql.match(/\$PW\b/g)).toHaveLength(1);
    expect(psql).toContain('PGPASSWORD="$PW"');
    // The lookup value goes to psql's stdin, never on a command line.
    expect(lookup).toContain('printf \'%s\\n\' "$VALUE" | bash "$PERSON_PSQL"');
    expect(lookup.match(/\$VALUE\b/g)!.length).toBeLessThanOrEqual(4);
  });

  it('never print a secret: no message refers to a password, verifier, value, identity, host or resource id', () => {
    const sensitive = /\$\{?(PW|VERIFIER|VALUE|SECRET_JSON|CALLER_ID|BASTION_ID|DB_SECRET_ARN|DB_INSTANCE|SECRET_STATE|policy|out|DB_HOST|PGPASSWORD)\b/;
    let messages = 0;
    for (const t of TOOLS) {
      for (const m of code(readTool(t)).matchAll(/\b(?:echo|note|die|usage_error|say|result)\s+"((?:[^"\\]|\\.)*)"/g)) {
        messages += 1;
        expect({ t, message: m[1], leaks: sensitive.test(m[1]) }).toEqual({ t, message: m[1], leaks: false });
      }
    }
    expect(messages).toBeGreaterThan(40);
  });

  it('limit the secret to its owner: an explicit deny for every identity but the caller, keyed on the caller\'s user id', () => {
    const login = readTool('person-login.sh');
    expect(login).toContain('aws sts get-caller-identity');
    expect(login).toContain("CALLER_ID=$(jq -r '.UserId // empty' \"$WORKDIR/identity.json\")");
    const policy = login.match(/jq -n --arg me "\$CALLER_ID" '(\{[\s\S]*?\})' > "\$WORKDIR\/policy\.json"/)![1];
    expect(policy).toContain('Effect: "Deny"');
    expect(policy).toContain('Principal: "*"');
    expect(policy).toContain('Condition: {StringNotEquals: {"aws:userid": $me}}');
    // The value actions, and the actions that would remove, replace or copy
    // the policy itself: a policy another identity can delete protects nothing.
    const actions = [
      'GetSecretValue', 'PutSecretValue', 'UpdateSecret', 'UpdateSecretVersionStage', 'RotateSecret',
      'PutResourcePolicy', 'DeleteResourcePolicy', 'ReplicateSecretToRegions',
    ];
    for (const action of actions) {
      expect(policy).toContain(`"secretsmanager:${action}"`);
    }
    // The read-back check requires every one of them.
    const isMine = login.match(/^POLICY_IS_MINE='([\s\S]*?)'$/m)![1];
    for (const action of actions) {
      expect(isMine).toContain(`"secretsmanager:${action}"`);
    }
    // The secret is created without a value; the policy is set and read back
    // before the first password is stored.
    expect(login).not.toMatch(/create-secret[^\n]*SecretString/);
    const create = login.indexOf('aws secretsmanager create-secret');
    const protect = login.indexOf('protect_secret\n', create);
    const store = login.indexOf('store_password\n', protect);
    expect(create).toBeGreaterThan(-1);
    expect(protect).toBeGreaterThan(create);
    expect(store).toBeGreaterThan(protect);
    expect(login).toContain('--resource-policy "file://$WORKDIR/policy.json" --block-public-policy');
  });

  it('send only the verifier to the ops host, inside a procedure call built from checked parts', () => {
    const login = readTool('person-login.sh');
    const payload = login.match(/^emit_ops_payload\(\) \{[\s\S]*?^\}$/m)![0];
    expect(payload).not.toMatch(/\$PW\b|\$VERIFIER\b/);
    expect(login).toContain(`write_ops_payload "CALL jale_ops.\${procedure}('\${HANDLE}', '\${VERIFIER}', \${DAYS});"`);
    expect(login).toContain(`write_ops_payload "CALL jale_ops.remove_person('\${HANDLE}');"`);
    // The verifier is checked against the SCRAM-SHA-256 shape before it is used.
    expect(login).toContain('[[ "$VERIFIER" =~ ^SCRAM-SHA-256\\$[0-9]{4,7}:[A-Za-z0-9+/]+=*\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$ ]]');
    // The call reaches psql on its stdin, with terse errors, and the ops host
    // prints a result code, never psql's text.
    expect(payload).toContain('printf \'%s\\n\' "$PERSON_CALL" | psql -X -q');
    expect(payload).toContain('-v ON_ERROR_STOP=1 -v VERBOSITY=terse -f - >/dev/null 2>"$ERR"');
    expect(payload).not.toMatch(/cat "\$ERR"|sed [^\n]*"\$ERR"|>&2/);
  });

  it('wait for the ops host a bounded time, a little over Run Command\'s default timeouts', () => {
    const login = readTool('person-login.sh');
    const poll = Number(login.match(/^SSM_POLL_SECONDS=(\d+)$/m)?.[1]);
    const polls = Number(login.match(/^SSM_MAX_POLLS=(\d+)$/m)?.[1]);
    expect(poll).toBe(3);
    expect(polls).toBe(2500);
    // The defaults: an hour to deliver a command and an hour to run it. The
    // reads have a wait between each two, so the least time the bound takes
    // is one wait fewer than the reads.
    expect((polls - 1) * poll).toBeGreaterThan(2 * 3600);
    expect(poll * polls).toBeLessThanOrEqual(2 * 3600 + 600);
    // The message states the bound as it is kept: a number of reads, and the
    // least time they take.
    expect(login).toContain('did not finish after $SSM_MAX_POLLS status reads (at least $(( (SSM_MAX_POLLS - 1) * SSM_POLL_SECONDS / 60 )) minutes)');
    expect(login).not.toContain('did not finish within');
    // A failed status read is never taken for a command still running.
    expect(login).not.toContain('|| echo "Pending"');
  });

  it('never call running it again safe once the command is sent: an unknown or failed outcome points at the ops-command log first', () => {
    const login = readTool('person-login.sh');
    expect(login).not.toContain('re-running converges');
    expect(login).not.toMatch(/Re-run: bash scripts\/ops\/person-login\.sh \$ACTION/);
    // After the send, every exit but a missing command id goes through the
    // one next step: "until" while that command may still run, "first" once
    // it has ended.
    const body = login.match(/^run_on_ops_host\(\) \{[\s\S]*?^\}$/m)![0];
    const afterSend = body.slice(body.indexOf('[[ -n "$cmd_id"'));
    const exits = [...afterSend.matchAll(/\bdie "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(exits[0]).toBe('the ops host returned no command id');
    expect(exits.slice(1).map((e) => e.match(/\$\(next_step (until|first)\)$/)?.[1])).toEqual(['until', 'until', 'first', 'first', 'first']);
    // A failed create or renew does too, except a login renew may not change.
    const results = login.slice(login.indexOf('case "$RESULT" in'));
    expect(results).toContain('die "${RESULT#*|}; your secret holds a new password that the database may not know. $(next_step first)" ;;');
    // The help promises nothing the messages do not keep.
    const help = spawnSync('bash', [path.join(opsDir, 'person-login.sh'), '--help'], { encoding: 'utf8' }).stdout
      .replace(/^#\s*/gm, '').replace(/\s+/g, ' ');
    expect(help).not.toContain('Re-run it after a failure');
    expect(help.split('After a failure, run it again unless its message says otherwise.')).toHaveLength(3);
  });

  it('record every command sent to the ops host, with no way around it', () => {
    const login = readTool('person-login.sh');
    expect(login).toMatch(/^OPS_COMMAND_LOG_GROUP="\/jale\/audit\/ops-command"$/m);
    expect(code(login).match(/aws ssm send-command/g)).toHaveLength(1);
    expect(login).toContain('CloudWatchOutputConfig: {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}');
    expect(login).toContain(".CloudWatchOutputConfig == {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}");
    expect(login.indexOf('aws logs describe-log-groups')).toBeLessThan(login.indexOf('aws ssm send-command'));
    expect(login).not.toContain('without-command-log');
    // The same group as run-migrations.sh.
    const runMigrations = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
    expect(runMigrations.match(/^OPS_COMMAND_LOG_GROUP="[^"]+"$/m)![0]).toBe(login.match(/^OPS_COMMAND_LOG_GROUP="[^"]+"$/m)![0]);
  });

  it('person-psql.sh requires psql 16 or newer before anything else, and opens a port forward through the ops host', () => {
    const psql = readTool('person-psql.sh');
    expect(psql).toMatch(/^MIN_PSQL_MAJOR=16$/m);
    const check = psql.indexOf('(( BASH_REMATCH[1] >= MIN_PSQL_MAJOR ))');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(psql.indexOf('aws secretsmanager'));
    expect(psql).toContain('--document-name AWS-StartPortForwardingSessionToRemoteHost');
    expect(psql).toContain('--parameters "file://$WORKDIR/forward.json"');
    expect(psql).toContain('PGSSLMODE=require');
  });

  it('person-lookup.sh reads the value hidden and binds it; the psql script holds no value', () => {
    const lookup = readTool('person-lookup.sh');
    expect(lookup).toContain('read -r -s -p "$KIND to look up (hidden): " VALUE');
    expect(lookup).toContain('\\prompt lookup_value\nSELECT jale_ops.find_user($1, $2) \\bind :kind :lookup_value \\g');
    expect(lookup).toContain("cat > \"$WORKDIR/lookup.sql\" <<'LOOKUP'");
  });

  it('stay within bash 3.2, which macOS ships', () => {
    for (const t of TOOLS) {
      const text = code(readTool(t));
      expect(text).not.toMatch(/declare -A|local -n|mapfile|readarray|\$\{\w+,,\}|\$\{\w+\^\^\}|;;&|\bwait -n\b/);
    }
  });

  it('pass bash -n', () => {
    for (const t of TOOLS) execFileSync('bash', ['-n', path.join(opsDir, t)]);
  });
});

// ---------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------

const PYTHON = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

const FAKE_AWS = String.raw`#!__PYTHON__
import json, os, pathlib, re, signal, subprocess, sys, time

STATE = pathlib.Path(os.environ["FAKE_STATE"])
ARGV = sys.argv[1:]
with open(STATE / "argv.log", "a") as f:
    f.write(json.dumps({"tool": "aws", "side": os.environ.get("FAKE_SIDE", "local"), "argv": ARGV}) + "\n")

if ARGV == ["--version"]:
    print(os.environ.get("FAKE_AWS_VERSION", "aws-cli/2.17.0 Python/3.12.0 Linux/6.0 exe/x86_64"))
    sys.exit(0)

def opt(name):
    if name in ARGV:
        i = ARGV.index(name)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return None

def param(value):
    if value is not None and value.startswith("file://"):
        p = value[len("file://"):]
        return sys.stdin.read() if p == "/dev/stdin" else pathlib.Path(p).read_text()
    return value

def fail(code, op):
    sys.stderr.write("\nAn error occurred (%s) when calling the %s operation: FAKE-ERROR-DETAIL-MUST-NOT-PRINT\n" % (code, op))
    sys.exit(254)

def sdir(name):
    d = STATE / name
    d.mkdir(exist_ok=True)
    return d

def key(sid):
    return sid.replace("/", "__")

def caller():
    return os.environ.get("FAKE_CALLER_USERID", "AIDATESTFAKEUSER0001")

def denied(sid, action):
    p = sdir("policies") / key(sid)
    if not p.exists():
        return False
    for st in json.loads(p.read_text()).get("Statement", []):
        acts = st.get("Action", [])
        acts = [acts] if isinstance(acts, str) else acts
        cond = st.get("Condition", {}).get("StringNotEquals", {})
        uid = [v for k, v in cond.items() if k.lower() == "aws:userid"]
        if st.get("Effect") == "Deny" and ("secretsmanager:" + action) in acts and uid and caller() != uid[0]:
            return True
    return False

def bump(name):
    p = STATE / (name + ".count")
    n = int(p.read_text()) + 1 if p.exists() else 1
    p.write_text(str(n))
    return n

service, command = ARGV[0], ARGV[1]
op = "".join(w.capitalize() for w in command.split("-"))
if command in os.environ.get("FAKE_FAIL_COMMANDS", "").split(","):
    fail(os.environ.get("FAKE_FAIL_CODE", "AccessDeniedException"), op)

if service == "sts" and command == "get-caller-identity":
    print(json.dumps({"UserId": caller(), "Account": "FAKE-ACCOUNT-MUST-NOT-PRINT",
                      "Arn": "arn:aws:iam::FAKE-ACCOUNT-MUST-NOT-PRINT:user/FAKE-CALLER-NAME-MUST-NOT-PRINT"}))
elif service == "cloudformation" and command == "describe-stacks":
    print("None" if os.environ.get("FAKE_NO_BASTION") else "test-bastion-instance")
elif service == "cloudformation" and command == "describe-stack-resources":
    q = opt("--query") or ""
    if "AWS::RDS::DBInstance" in q:
        print("test-db-instance")
    elif "JaleDatabaseStackDatabaseSecret" in q:
        print("test-secret-master")
    else:
        print("None")
elif service == "rds" and command == "describe-db-instances":
    print(json.dumps({"host": "db.test.invalid", "port": 5432, "dbname": "jale"}))
elif service == "logs" and command == "describe-log-groups":
    print(os.environ.get("FAKE_COMMAND_LOG_GROUPS", "1"))
elif service == "secretsmanager":
    sid = opt("--secret-id")
    if command == "get-random-password":
        n = bump("random-password")
        head = "Testgen%02dpw" % n
        print(head + "x" * (int(opt("--password-length")) - len(head)))
    elif command == "describe-secret":
        p = sdir("secrets") / key(sid)
        if not p.exists():
            fail("ResourceNotFoundException", op)
        meta = json.loads(p.read_text())
        out = {"Name": "FAKE-NAME-MUST-NOT-PRINT", "ARN": "FAKE-ARN-MUST-NOT-PRINT",
               "VersionIdsToStages": {"v1": ["AWSCURRENT"]} if "value" in meta else {}}
        if meta.get("deleting"):
            out["DeletedDate"] = "2026-10-05T00:00:00Z"
        print(json.dumps(out))
    elif command == "create-secret":
        req = json.loads(param(opt("--cli-input-json")))
        p = sdir("secrets") / key(req["Name"])
        if p.exists():
            fail("ResourceExistsException", op)
        meta = {"meta": {k: v for k, v in req.items() if k != "SecretString"}}
        if "SecretString" in req:
            meta["value"] = req["SecretString"]
        p.write_text(json.dumps(meta))
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT", "Name": "FAKE-NAME-MUST-NOT-PRINT"}))
    elif command == "put-resource-policy":
        if not (sdir("secrets") / key(sid)).exists():
            fail("ResourceNotFoundException", op)
        if denied(sid, "PutResourcePolicy"):
            fail("AccessDeniedException", op)
        (sdir("policies") / key(sid)).write_text(param(opt("--resource-policy")))
        with open(STATE / "policy-calls.log", "a") as f:
            f.write(json.dumps({"block_public": "--block-public-policy" in ARGV}) + "\n")
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    elif command == "delete-resource-policy":
        if not (sdir("secrets") / key(sid)).exists():
            fail("ResourceNotFoundException", op)
        if denied(sid, "DeleteResourcePolicy"):
            fail("AccessDeniedException", op)
        (sdir("policies") / key(sid)).unlink(missing_ok=True)
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    elif command == "replicate-secret-to-regions":
        if not (sdir("secrets") / key(sid)).exists():
            fail("ResourceNotFoundException", op)
        if denied(sid, "ReplicateSecretToRegions"):
            fail("AccessDeniedException", op)
        with open(STATE / "replications.log", "a") as f:
            f.write(sid + "\n")
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    elif command == "get-resource-policy":
        p = sdir("policies") / key(sid)
        print(p.read_text() if p.exists() else "None")
    elif command == "put-secret-value":
        req = json.loads(param(opt("--cli-input-json")))
        p = sdir("secrets") / key(req["SecretId"])
        if not p.exists():
            fail("ResourceNotFoundException", op)
        if denied(req["SecretId"], "PutSecretValue"):
            fail("AccessDeniedException", op)
        meta = json.loads(p.read_text())
        meta["value"] = req["SecretString"]
        p.write_text(json.dumps(meta))
        with open(STATE / "secret-writes.log", "a") as f:
            f.write(req["SecretId"] + "\n")
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    elif command == "get-secret-value":
        p = sdir("secrets") / key(sid)
        if not p.exists():
            fail("ResourceNotFoundException", op)
        if denied(sid, "GetSecretValue"):
            fail("AccessDeniedException", op)
        meta = json.loads(p.read_text())
        if "value" not in meta:
            fail("ResourceNotFoundException", op)
        print(meta["value"])
    elif command == "delete-secret":
        p = sdir("secrets") / key(sid)
        if not p.exists():
            fail("ResourceNotFoundException", op)
        p.unlink()
        (sdir("policies") / key(sid)).unlink(missing_ok=True)
        with open(STATE / "deletes.log", "a") as f:
            f.write(json.dumps({"id": sid, "force": "--force-delete-without-recovery" in ARGV}) + "\n")
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    else:
        sys.stderr.write("fake aws: unsupported secretsmanager command %s\n" % command)
        sys.exit(2)
elif service == "ssm" and command == "send-command":
    req = json.loads(param(opt("--cli-input-json")))
    n = bump("ssm")
    d = sdir("ssm")
    (d / ("%d.sh" % n)).write_text(req["Parameters"]["commands"][0])
    (d / ("%d.request.json" % n)).write_text(json.dumps({k: v for k, v in req.items() if k != "Parameters"}))
    env = dict(os.environ, PATH=os.environ["FAKE_REMOTE_PATH"], FAKE_SIDE="remote", TMPDIR=str(STATE / "remote-tmp"))
    r = subprocess.run(["/bin/bash", str(d / ("%d.sh" % n))], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    (d / ("%d.out" % n)).write_text(r.stdout)
    (d / ("%d.err" % n)).write_text(r.stderr)
    (d / ("%d.rc" % n)).write_text(str(r.returncode))
    print("cmd-%d" % n)
elif service == "ssm" and command == "get-command-invocation":
    n = opt("--command-id").split("-")[1]
    d = STATE / "ssm"
    q = opt("--query")
    if q in os.environ.get("FAKE_FAIL_QUERIES", "").split(","):
        fail(os.environ.get("FAKE_FAIL_CODE", "AccessDeniedException"), op)
    if q == "Status":
        # The first N status reads refused the way SSM answers just after a send.
        if bump("status-read") <= int(os.environ.get("FAKE_SSM_INVISIBLE_READS", "0")):
            fail("InvocationDoesNotExist", op)
        print("Success" if (d / (n + ".rc")).read_text() == "0" else "Failed")
    elif q == "StandardOutputContent":
        # The output as this read returns it; the ops-command log keeps it whole.
        drop = os.environ.get("FAKE_SSM_OUTPUT_DROP")
        text = (d / (n + ".out")).read_text()
        sys.stdout.write("".join(l for l in text.splitlines(True) if not (drop and re.match(drop, l))))
    elif q == "StandardErrorContent":
        sys.stdout.write((d / (n + ".err")).read_text())
elif service == "ssm" and command == "start-session":
    with open(STATE / "sessions.log", "a") as f:
        f.write(json.dumps({"target": opt("--target"), "document": opt("--document-name"),
                            "parameters": json.loads(param(opt("--parameters")))}) + "\n")
    if os.environ.get("FAKE_SESSION_FAIL"):
        fail("TargetNotConnected", "StartSession")
    (STATE / "session.pid").write_text(str(os.getpid()))
    def stop(*_):
        (STATE / "session.pid").unlink(missing_ok=True)
        (STATE / "session.stopped").write_text("1")
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    lp = json.loads(param(opt("--parameters")))["localPortNumber"][0]
    print("Starting session with SessionId: FAKE-CALLER-NAME-MUST-NOT-PRINT-0a1b2c3d", flush=True)
    print("Port %s opened for sessionId FAKE-CALLER-NAME-MUST-NOT-PRINT-0a1b2c3d." % lp, flush=True)
    print("Waiting for connections...", flush=True)
    time.sleep(120)
    stop()
else:
    sys.stderr.write("fake aws: unsupported command %s %s\n" % (service, command))
    sys.exit(2)
`;

/** The ops host's psql: the master login, playing the three procedures of migration 112. */
const FAKE_REMOTE_PSQL = String.raw`#!__PYTHON__
import base64, json, os, pathlib, re, sys

STATE = pathlib.Path(os.environ["FAKE_STATE"])
ARGV = sys.argv[1:]
with open(STATE / "argv.log", "a") as f:
    f.write(json.dumps({"tool": "psql", "side": "remote", "argv": ARGV}) + "\n")

if os.environ.get("PGPASSWORD") != "test-master-admin-pw":
    sys.stderr.write('psql: error: connection to server at "db.test.invalid", port 5432 failed: FATAL:  password authentication failed\n')
    sys.exit(2)
sql = sys.stdin.read()
with open(STATE / "calls.log", "a") as f:
    f.write(json.dumps({"sql": sql, "argv_has_sql": any("CALL" in a for a in ARGV)}) + "\n")
roles = STATE / "roles"
roles.mkdir(exist_ok=True)
mode = os.environ.get("FAKE_REMOTE_FAIL", "")
if mode == "connect":
    sys.stderr.write('psql: error: connection to server at "db.test.invalid", port 5432 failed: Connection refused\n')
    sys.exit(2)
if mode == "procedure":
    sys.stderr.write("psql:<stdin>:1: ERROR:  procedure jale_ops.provision_person(unknown, unknown, integer) does not exist\n")
    sys.exit(3)

m = re.fullmatch(r"CALL jale_ops\.(provision_person|renew_person)\('([a-z][a-z0-9]{1,15})', '([^']*)', ([0-9]+)\);\s*", sql)
r = re.fullmatch(r"CALL jale_ops\.remove_person\('([a-z][a-z0-9]{1,15})'\);\s*", sql)
VERIFIER = r"^SCRAM-SHA-256\$[1-9][0-9]{3,6}:(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$"
def err(msg):
    sys.stderr.write("psql:<stdin>:1: ERROR:  %s\n" % msg)
    sys.exit(3)
if m:
    proc, handle, verifier, days = m.group(1), m.group(2), m.group(3), int(m.group(4))
    login = "jale_person_" + handle
    if not re.match(VERIFIER, verifier):
        err("%s: the verifier must be a SCRAM-SHA-256 verifier with at least 4096 iterations" % proc)
    if not 1 <= days <= 90:
        err("%s: the login must expire in 1 to 90 days" % proc)
    f = roles / (login + ".json")
    if proc == "provision_person" and f.exists():
        err("provision_person: %s already exists; renew or remove it" % login)
    if proc == "renew_person" and not f.exists():
        err("renew_person: %s does not exist" % login)
    if mode == "shape":
        err("%s: %s does not have the operator membership shape; remove it instead" % (proc, login))
    f.write_text(json.dumps({"verifier": verifier, "days": days}))
    sys.stderr.write("psql:<stdin>:1: NOTICE:  %s: %s can sign in until 2026-11-04T12:00:00Z\n" % (proc, login))
elif r:
    login = "jale_person_" + r.group(1)
    f = roles / (login + ".json")
    if not f.exists():
        err("remove_person: %s does not exist" % login)
    f.unlink()
    sys.stderr.write("psql:<stdin>:1: NOTICE:  remove_person: %s removed; 1 open sessions\n" % login)
else:
    err('syntax error at or near "FAKE-UNEXPECTED"')
`;

/** The person's own psql. */
const FAKE_LOCAL_PSQL = String.raw`#!__PYTHON__
import base64, hashlib, hmac, json, os, pathlib, re, sys

STATE = pathlib.Path(os.environ["FAKE_STATE"])
ARGV = sys.argv[1:]
with open(STATE / "argv.log", "a") as f:
    f.write(json.dumps({"tool": "psql", "side": "local", "argv": ARGV}) + "\n")
if ARGV == ["--version"]:
    print("psql (PostgreSQL) %s.4 (fake)" % os.environ.get("FAKE_LOCAL_PSQL_MAJOR", "16"))
    sys.exit(0)

env = {k: os.environ.get(k) for k in ("PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGSSLMODE")}
with open(STATE / "psql-env.log", "a") as f:
    f.write(json.dumps(dict(env, password_set=bool(os.environ.get("PGPASSWORD")))) + "\n")

pid = STATE / "session.pid"
alive = False
if pid.exists():
    try:
        os.kill(int(pid.read_text()), 0)
        alive = True
    except OSError:
        pass
if not alive or env["PGHOST"] != "127.0.0.1":
    sys.stderr.write('psql: error: connection to server at "127.0.0.1", port %s failed: Connection refused\n' % env["PGPORT"])
    sys.exit(2)

def scram_ok(verifier, pw):
    m = re.match(r"^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$", verifier)
    salted = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(m.group(2)), int(m.group(1)))
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    return hashlib.sha256(client_key).digest() == base64.b64decode(m.group(3))

role = STATE / "roles" / ((env["PGUSER"] or "") + ".json")
if not role.exists() or not scram_ok(json.loads(role.read_text())["verifier"], os.environ.get("PGPASSWORD", "")):
    sys.stderr.write('psql: error: connection to server at "127.0.0.1", port %s failed: FATAL:  password authentication failed for user "%s"\n' % (env["PGPORT"], env["PGUSER"]))
    sys.exit(2)

if "-c" in ARGV:
    print("%s|on|30s" % env["PGUSER"])
elif "-f" in ARGV:
    script = pathlib.Path(ARGV[ARGV.index("-f") + 1]).read_text()
    variables = {}
    for i, a in enumerate(ARGV):
        if a == "-v":
            k, _, v = ARGV[i + 1].partition("=")
            variables[k] = v
    assert "\\prompt lookup_value" in script and "\\bind :kind :lookup_value" in script, script
    value = sys.stdin.readline().rstrip("\n")
    with open(STATE / "lookups.log", "a") as f:
        f.write(json.dumps({"kind": variables.get("kind"), "sha256": hashlib.sha256(value.encode()).hexdigest()}) + "\n")
    answer = json.loads(os.environ.get("FAKE_LOOKUP", "{}")).get(value)
    if answer == "MANY":
        sys.stderr.write("psql:%s:2: ERROR:  find_user: 2 users match; look the user up by another kind\n" % ARGV[ARGV.index("-f") + 1])
        sys.exit(3)
    print(answer or "")
else:
    sys.stdin.read()
    print("fake interactive psql session ended")
`;

/** Real tools the scripts may run, each behind a recording wrapper. */
const WRAPPED_TOOLS = [
  'jq', 'python3', 'grep', 'head', 'tail', 'tr', 'cut', 'sed', 'awk', 'mktemp', 'rm', 'cat', 'seq', 'sleep',
  'pkill', 'cp', 'dirname', 'bash',
];

const MASTER_SECRET = { username: 'jale_admin', password: 'test-master-admin-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' };
const ME = 'AIDATESTFAKEUSER0001';
const SOMEONE_ELSE = 'AROATESTFAKEROLE0002:someone-else';
const HANDLE = 'tester1';
const LOGIN = `jale_person_${HANDLE}`;
const SECRET = `jale/person-${HANDLE}/db`;
/**
 * The next step after an outcome this run could not see, or a failed call:
 * the ops-command log first, then renew whenever the login exists.
 */
const LOG_UNTIL = (action: string) => `Check the ops-command log until that command ('personal login: ${action}') has ended.`;
const LOG_FIRST = (action: string) => `Check the ops-command log for that command ('personal login: ${action}') first.`;
const CREATE_OR_RENEW = `Then, if the login exists or was just created, run: bash scripts/ops/person-login.sh renew ${HANDLE}. Run create only if the log shows that no login was created.`;
const REMOVE_AGAIN = `Then run: bash scripts/ops/person-login.sh remove ${HANDLE}.`;
const NEVER_PRINTED = [
  'db.test.invalid', 'test-bastion-instance', 'test-db-instance', 'test-secret-master', 'test-master-admin-pw',
  'FAKE-ERROR-DETAIL-MUST-NOT-PRINT', 'FAKE-ARN-MUST-NOT-PRINT', 'FAKE-NAME-MUST-NOT-PRINT', 'FAKE-CALLER-NAME-MUST-NOT-PRINT',
  'FAKE-ACCOUNT-MUST-NOT-PRINT', 'SCRAM-SHA-256$', ME, SOMEONE_ELSE, 'Testgen',
];

interface Harness { dir: string; bin: string; remote: string; state: string; home: string; repo: string }
interface RunResult { status: number | null; stdout: string; stderr: string }

function makeHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-person-'));
  try {
    return buildHarness(dir);
  } catch (err) {
    // A setup that fails (a tool missing from scripts/ops/, say) must not
    // leave its directory behind: afterEach never sees a harness to remove.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function buildHarness(dir: string): Harness {
  const h: Harness = {
    dir, bin: path.join(dir, 'bin'), remote: path.join(dir, 'remote-bin'), state: path.join(dir, 'state'),
    home: path.join(dir, 'home'), repo: path.join(dir, 'repo'),
  };
  for (const d of [h.bin, h.remote, h.state, h.home, path.join(h.state, 'remote-tmp'), path.join(h.state, 'roles'),
    path.join(h.state, 'secrets'), path.join(h.repo, 'scripts', 'ops'), path.join(h.repo, 'scripts', 'lib')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const t of TOOLS) fs.copyFileSync(path.join(opsDir, t), path.join(h.repo, 'scripts', 'ops', t));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', 'scram-verifier.py'), path.join(h.repo, 'scripts', 'lib', 'scram-verifier.py'));
  const aws = FAKE_AWS.replace('__PYTHON__', PYTHON);
  fs.writeFileSync(path.join(h.bin, 'aws'), aws, { mode: 0o755 });
  fs.writeFileSync(path.join(h.remote, 'aws'), aws, { mode: 0o755 });
  fs.writeFileSync(path.join(h.bin, 'psql'), FAKE_LOCAL_PSQL.replace('__PYTHON__', PYTHON), { mode: 0o755 });
  fs.writeFileSync(path.join(h.remote, 'psql'), FAKE_REMOTE_PSQL.replace('__PYTHON__', PYTHON), { mode: 0o755 });
  fs.writeFileSync(path.join(h.bin, 'session-manager-plugin'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  for (const tool of WRAPPED_TOOLS) {
    const real = execFileSync('bash', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim();
    if (!real) continue;
    for (const where of [h.bin, h.remote]) {
      fs.writeFileSync(path.join(where, tool), [
        '#!/bin/bash',
        `{ printf '%s' "\${0##*/}"; printf ' %q' "$@"; printf '\\n'; } >> "$FAKE_STATE/argv-wrapped.log"`,
        `exec ${real} "$@"`,
      ].join('\n') + '\n', { mode: 0o755 });
    }
  }
  fs.writeFileSync(path.join(h.state, 'secrets', 'test-secret-master'), JSON.stringify({ value: JSON.stringify(MASTER_SECRET) }));
  return h;
}

function run(h: Harness, tool: string, args: string[], env: Record<string, string> = {}, input = '', timeoutMs = 120_000): RunResult {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('AWS_') && !k.startsWith('PG')) base[k] = v;
  }
  const r = spawnSync('/bin/bash', [path.join(h.repo, 'scripts', 'ops', tool), ...args], {
    cwd: h.repo,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...base,
      HOME: h.home,
      PATH: `${h.bin}:${process.env.PATH ?? ''}`,
      AWS_REGION: 'us-east-2',
      AWS_CONFIG_FILE: path.join(h.home, 'no-aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(h.home, 'no-aws-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      FAKE_STATE: h.state,
      FAKE_REMOTE_PATH: `${h.remote}:${process.env.PATH ?? ''}`,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A local `sleep` that returns at once and records how long it was asked to wait. */
function installRecordingSleep(h: Harness): void {
  fs.writeFileSync(path.join(h.bin, 'sleep'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$FAKE_STATE/sleeps.log"\n', { mode: 0o755 });
}

/**
 * An ops host whose commands never finish: every status read answers
 * InProgress, from a bash stub (the Python fake is too slow to be asked
 * thousands of times), and every other call goes to the fake AWS CLI.
 */
function installNeverFinishingOpsHost(h: Harness): void {
  fs.renameSync(path.join(h.bin, 'aws'), path.join(h.bin, 'aws-fake'));
  fs.writeFileSync(path.join(h.bin, 'aws'), [
    '#!/bin/bash',
    'if [[ "$1 $2" == "ssm get-command-invocation" && " $* " == *" --query Status "* ]]; then',
    '  printf \'x\\n\' >> "$FAKE_STATE/status-reads.log"',
    '  echo InProgress',
    '  exit 0',
    'fi',
    'exec "${0%/*}/aws-fake" "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
}

/** One call made straight to the fake AWS CLI, as an identity acting outside the tools would make it. */
function awsAs(h: Harness, caller: string, args: string[]): RunResult {
  const r = spawnSync(path.join(h.bin, 'aws'), args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${h.bin}:${process.env.PATH ?? ''}`, HOME: h.home, FAKE_STATE: h.state, FAKE_CALLER_USERID: caller },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function lines(h: Harness, name: string): string[] {
  const f = path.join(h.state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

function awsCalls(h: Harness, side = 'local'): string[][] {
  return lines(h, 'argv.log').map((l) => JSON.parse(l)).filter((c) => c.tool === 'aws' && c.side === side).map((c) => c.argv);
}

function argvText(h: Harness): string {
  return lines(h, 'argv.log').join('\n') + '\n' + lines(h, 'argv-wrapped.log').join('\n');
}

function localArgvText(h: Harness): string {
  return lines(h, 'argv.log').filter((l) => JSON.parse(l).side === 'local').join('\n');
}

function secretMeta(h: Harness, id: string): { meta?: Record<string, unknown>; value?: string } | undefined {
  const f = path.join(h.state, 'secrets', id.replace(/\//g, '__'));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
}

function secretValue(h: Harness, id: string): Record<string, string> | undefined {
  const v = secretMeta(h, id)?.value;
  return v === undefined ? undefined : JSON.parse(v);
}

function policy(h: Harness, id: string): any {
  const f = path.join(h.state, 'policies', id.replace(/\//g, '__'));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
}

function role(h: Harness, login: string): { verifier: string; days: number } | undefined {
  const f = path.join(h.state, 'roles', `${login}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
}

function calls(h: Harness): Array<{ sql: string; argv_has_sql: boolean }> {
  return lines(h, 'calls.log').map((l) => JSON.parse(l));
}

/** The latest command's output on the fake ops host: what the ops-command log records. */
function opsLog(h: Harness): string {
  const n = fs.readFileSync(path.join(h.state, 'ssm.count'), 'utf8').trim();
  return fs.readFileSync(path.join(h.state, 'ssm', `${n}.out`), 'utf8');
}

function scramMatches(verifier: string, password: string): boolean {
  const m = verifier.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
  if (!m) return false;
  const salted = crypto.pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return crypto.createHash('sha256').update(clientKey).digest().equals(Buffer.from(m[3], 'base64'))
    && serverKey.equals(Buffer.from(m[4], 'base64'));
}

/** Every password the fake AWS handed out. */
function generated(h: Harness): string[] {
  const n = Number(fs.existsSync(path.join(h.state, 'random-password.count')) ? fs.readFileSync(path.join(h.state, 'random-password.count'), 'utf8') : 0);
  return Array.from({ length: n }, (_, i) => { const head = `Testgen${String(i + 1).padStart(2, '0')}pw`; return head + 'x'.repeat(40 - head.length); });
}

function expectNoLeaks(h: Harness, r: RunResult, extra: string[] = []): void {
  const printed = r.stdout + r.stderr;
  for (const marker of [...NEVER_PRINTED, ...generated(h), ...extra]) expect(printed).not.toContain(marker);
  const argv = argvText(h);
  for (const pw of generated(h)) expect(argv).not.toContain(pw);
  for (const c of calls(h)) expect(c.argv_has_sql).toBe(false);
  // The ops host's output, which the ops-command log group records: a result
  // code and the sentinel, nothing else.
  for (const f of fs.existsSync(path.join(h.state, 'ssm')) ? fs.readdirSync(path.join(h.state, 'ssm')).filter((n) => n.endsWith('.out')) : []) {
    const out = fs.readFileSync(path.join(h.state, 'ssm', f), 'utf8').split('\n').filter(Boolean);
    for (const l of out) expect(l).toMatch(/^(PERSON_RESULT=[a-z]+\|[^|]*|__JALE_PERSON_LOGIN_OK__)$/);
    expect(out.join('\n')).not.toMatch(/jale_person_|SCRAM|db\.test\.invalid/);
  }
}

describe('person-login.sh against a fake AWS CLI and a fake ops host', () => {
  jest.setTimeout(120_000);
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

  it('create: a secret limited to the caller before it holds a value, an AWS password in it, and only its verifier sent to provision_person', () => {
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`>> ${LOGIN} can sign in until 2026-11-04T12:00:00Z`);

    // The order of the AWS calls: who am I, no secret yet, the ops host and
    // the log group, then create (no value), protect and read the policy back,
    // and only then a password, stored, and the command.
    const ops = awsCalls(h).map((a) => `${a[0]} ${a[1]}`).filter((c) => c !== '--version undefined');
    const at = (c: string) => ops.indexOf(c);
    expect(at('sts get-caller-identity')).toBe(0);
    expect(at('secretsmanager describe-secret')).toBeLessThan(at('secretsmanager create-secret'));
    expect(at('logs describe-log-groups')).toBeLessThan(at('secretsmanager create-secret'));
    expect(at('secretsmanager create-secret')).toBeLessThan(at('secretsmanager put-resource-policy'));
    expect(at('secretsmanager put-resource-policy')).toBeLessThan(at('secretsmanager get-resource-policy'));
    expect(ops.lastIndexOf('secretsmanager get-resource-policy')).toBeLessThan(at('secretsmanager get-random-password'));
    expect(at('secretsmanager get-random-password')).toBeLessThan(at('secretsmanager put-secret-value'));
    expect(at('secretsmanager put-secret-value')).toBeLessThan(at('ssm send-command'));

    // The secret was created without a value, then limited to the caller.
    const meta = secretMeta(h, SECRET)!;
    expect(meta.meta).toEqual({
      Name: SECRET,
      Description: `Personal database login ${LOGIN}, created by scripts/ops/person-login.sh`,
      Tags: [{ Key: 'project', Value: 'jale' }, { Key: 'db-login-kind', Value: 'person' }],
    });
    expect(policy(h, SECRET)).toEqual({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'OnlyItsOwnerUsesTheValue', Effect: 'Deny', Principal: '*',
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret',
          'secretsmanager:UpdateSecretVersionStage', 'secretsmanager:RotateSecret',
          'secretsmanager:PutResourcePolicy', 'secretsmanager:DeleteResourcePolicy', 'secretsmanager:ReplicateSecretToRegions'],
        Resource: '*', Condition: { StringNotEquals: { 'aws:userid': ME } },
      }],
    });
    expect(lines(h, 'policy-calls.log').map((l) => JSON.parse(l))).toEqual([{ block_public: true }]);

    // One AWS password, of the agreed shape, in the secret through stdin.
    const asked = awsCalls(h).filter((a) => a[1] === 'get-random-password');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(expect.arrayContaining(['--password-length', '40', '--exclude-punctuation', '--require-each-included-type']));
    const [pw] = generated(h);
    expect(secretValue(h, SECRET)).toEqual({ username: LOGIN, password: pw });
    expect(awsCalls(h).find((a) => a[1] === 'put-secret-value')).toEqual(expect.arrayContaining(['--cli-input-json', 'file:///dev/stdin']));

    // The ops host got the verifier of that password, in one procedure call,
    // on psql's stdin, in a recorded command, and never the password.
    expect(calls(h)).toHaveLength(1);
    const call = calls(h)[0].sql.trim();
    const m = call.match(/^CALL jale_ops\.provision_person\('tester1', '(SCRAM-SHA-256\$4096:[^']+)', 30\);$/);
    expect(m).not.toBeNull();
    expect(scramMatches(m![1], pw)).toBe(true);
    expect(role(h, LOGIN)).toEqual({ verifier: m![1], days: 30 });
    const payload = fs.readFileSync(path.join(h.state, 'ssm', '1.sh'), 'utf8');
    expect(payload).not.toContain(pw);
    const request = JSON.parse(fs.readFileSync(path.join(h.state, 'ssm', '1.request.json'), 'utf8'));
    expect(request).toMatchObject({
      DocumentName: 'AWS-RunShellScript', InstanceIds: ['test-bastion-instance'], Comment: 'personal login: create',
      CloudWatchOutputConfig: { CloudWatchOutputEnabled: true, CloudWatchLogGroupName: '/jale/audit/ops-command' },
    });
    expectNoLeaks(h, r, [m![1]]);
  });

  it('create --days sets the expiry; out-of-range days and bad handles are refused before any AWS call', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--days', '90', '--yes']).status).toBe(0);
    expect(role(h, LOGIN)!.days).toBe(90);
    const before = awsCalls(h).length;
    for (const args of [['create', HANDLE, '--days', '91'], ['create', HANDLE, '--days', '0'], ['renew', HANDLE, '--days', '7x'],
      ['create', 'A1'], ['create', 'x'], ['create', 'ab-c'], ['remove', HANDLE, '--days', '3'], ['rotate', HANDLE], [HANDLE]]) {
      const r = run(h, 'person-login.sh', [...args, '--yes']);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
    }
    expect(awsCalls(h).length).toBe(before);
  });

  it('a second identity cannot read or overwrite the secret, and create refuses to take it over', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const value = secretValue(h, SECRET);
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_CALLER_USERID: SOMEONE_ELSE });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the secret for handle ${HANDLE} is not limited to your identity; nothing was changed`);
    expect(secretValue(h, SECRET)).toEqual(value);
    expect(awsCalls(h).filter((a) => a[1] === 'get-random-password')).toHaveLength(1);
    // The policy is what stops them: the fake enforces it like Secrets Manager.
    const read = run(h, 'person-psql.sh', [HANDLE, '--check'], { FAKE_CALLER_USERID: SOMEONE_ELSE });
    expect(read.status).toBe(1);
    expect(read.stderr).toContain('reading your secret failed (AccessDeniedException)');
    expectNoLeaks(h, r);
  });

  it('a second identity cannot remove, replace or copy the secret\'s policy; its owner still can change it', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const before = policy(h, SECRET);
    // A policy that would hand the secret to the second identity.
    const takeover = path.join(h.dir, 'takeover-policy.json');
    fs.writeFileSync(takeover, JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: '*', Action: ['secretsmanager:GetSecretValue'], Resource: '*',
        Condition: { StringNotEquals: { 'aws:userid': SOMEONE_ELSE } } }],
    }));
    for (const args of [
      ['secretsmanager', 'delete-resource-policy', '--secret-id', SECRET],
      ['secretsmanager', 'put-resource-policy', '--secret-id', SECRET, '--resource-policy', `file://${takeover}`],
      ['secretsmanager', 'replicate-secret-to-regions', '--secret-id', SECRET, '--add-replica-regions', 'Region=us-west-2'],
    ]) {
      const other = awsAs(h, SOMEONE_ELSE, args);
      expect({ call: args[1], status: other.status, denied: other.stderr.includes('(AccessDeniedException)') })
        .toEqual({ call: args[1], status: 254, denied: true });
    }
    expect(policy(h, SECRET)).toEqual(before);
    expect(lines(h, 'replications.log')).toEqual([]);

    // The owner is not locked out of their own policy.
    const own = path.join(h.dir, 'own-policy.json');
    fs.writeFileSync(own, JSON.stringify(before));
    expect(awsAs(h, ME, ['secretsmanager', 'put-resource-policy', '--secret-id', SECRET, '--resource-policy', `file://${own}`]).status).toBe(0);
  });

  it('does not count a policy as limited to its owner unless it also denies changing or removing the policy', () => {
    // The secret exists without a value, under a policy that denies only the
    // value actions to everyone else: another identity could delete it.
    fs.writeFileSync(path.join(h.state, 'secrets', SECRET.replace(/\//g, '__')), JSON.stringify({ meta: { Name: SECRET } }));
    fs.mkdirSync(path.join(h.state, 'policies'), { recursive: true });
    fs.writeFileSync(path.join(h.state, 'policies', SECRET.replace(/\//g, '__')), JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Deny', Principal: '*', Resource: '*',
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret',
          'secretsmanager:UpdateSecretVersionStage', 'secretsmanager:RotateSecret'],
        Condition: { StringNotEquals: { 'aws:userid': ME } },
      }],
    }));
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the secret for handle ${HANDLE} is not limited to your identity; nothing was changed`);
    expect(awsCalls(h).some((a) => a[1] === 'put-resource-policy' || a[1] === 'put-secret-value' || a[1] === 'send-command')).toBe(false);
    expectNoLeaks(h, r);
  });

  it('refuses a root, federated or generated-name session before it creates anything', () => {
    for (const id of ['FAKE-ROOT-ACCOUNT-ID', 'AROATESTFAKEROLE0002:botocore-session-1730000000', 'FAKEFEDERATED:someone']) {
      const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_CALLER_USERID: id });
      expect(r.status).toBe(1);
      expect(r.stderr).not.toContain(id);
    }
    expect(awsCalls(h).some((a) => a[0] === 'secretsmanager')).toBe(false);
  });

  it('refuses before it creates anything when the ops-command log group is missing, and has no override', () => {
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_COMMAND_LOG_GROUPS: '0' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the ops-command log group does not exist, so the command would not be recorded; nothing was sent');
    expect(secretMeta(h, SECRET)).toBeUndefined();
    expect(awsCalls(h).some((a) => a[1] === 'send-command')).toBe(false);
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes', '--without-command-log']).status).toBe(2);
  });

  it('a failed provision leaves the secret ahead of the database, says to check the log first, and create converges when the log shows no login', () => {
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_REMOTE_FAIL: 'procedure' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`!! the personal-login procedures are not in the database yet (apply the migrations first); your secret holds a new password that the database may not know. ${LOG_FIRST('create')} ${CREATE_OR_RENEW}`);
    expect(role(h, LOGIN)).toBeUndefined();
    expectNoLeaks(h, r);

    // The log shows the call failed, so no login was created: create again.
    expect(opsLog(h)).toMatch(/^PERSON_RESULT=failed\|/m);
    const again = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('>> secret exists and is limited to your identity');
    const [, second] = generated(h);
    expect(secretValue(h, SECRET)!.password).toBe(second);
    expect(scramMatches(role(h, LOGIN)!.verifier, second)).toBe(true);
    expect(awsCalls(h).filter((a) => a[1] === 'create-secret')).toHaveLength(1);
  });

  it('resumes a secret left without its policy and without a value, and refuses one that holds a value without a policy', () => {
    fs.writeFileSync(path.join(h.state, 'secrets', SECRET.replace(/\//g, '__')), JSON.stringify({ meta: { Name: SECRET } }));
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('>> secret found without its policy and without a value; policy set');
    expect(policy(h, SECRET).Statement[0].Condition.StringNotEquals['aws:userid']).toBe(ME);

    const other = makeHarness();
    try {
      fs.writeFileSync(path.join(other.state, 'secrets', SECRET.replace(/\//g, '__')), JSON.stringify({ meta: { Name: SECRET }, value: '{"username":"x","password":"y"}' }));
      const refused = run(other, 'person-login.sh', ['create', HANDLE, '--yes']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is not limited to your identity');
      expect(awsCalls(other).some((a) => a[1] === 'put-resource-policy' || a[1] === 'put-secret-value')).toBe(false);
    } finally {
      fs.rmSync(other.dir, { recursive: true, force: true });
    }
  });

  it('create on an existing login says to renew', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the login already exists in the database; your secret now holds a password it does not know. Run: bash scripts/ops/person-login.sh renew tester1');
  });

  it('renew: a new password in the secret first, then its verifier to renew_person', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const r = run(h, 'person-login.sh', ['renew', HANDLE, '--days', '14', '--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`>> ${LOGIN} can sign in until 2026-11-04T12:00:00Z`);
    const [first, second] = generated(h);
    expect(secretValue(h, SECRET)!.password).toBe(second);
    const renew = calls(h)[1].sql.trim();
    expect(renew).toMatch(/^CALL jale_ops\.renew_person\('tester1', 'SCRAM-SHA-256\$4096:[^']+', 14\);$/);
    expect(scramMatches(role(h, LOGIN)!.verifier, second)).toBe(true);
    expect(scramMatches(role(h, LOGIN)!.verifier, first)).toBe(false);
    const ops = awsCalls(h).map((a) => a[1]);
    expect(ops.lastIndexOf('put-secret-value')).toBeLessThan(ops.lastIndexOf('send-command'));
    expectNoLeaks(h, r);
  });

  it('renew without a secret says to create, and a missing login says to create', () => {
    const none = run(h, 'person-login.sh', ['renew', HANDLE, '--yes']);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('you have no secret for handle tester1; use create');
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    fs.rmSync(path.join(h.state, 'roles', `${LOGIN}.json`));
    const gone = run(h, 'person-login.sh', ['renew', HANDLE, '--yes']);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain('the login does not exist in the database; your secret now holds a password nothing uses. Run: bash scripts/ops/person-login.sh create tester1');
  });

  describe('waiting for the command on the ops host', () => {
    const UNKNOWN = `its outcome is unknown. ${LOG_UNTIL('create')} ${CREATE_OR_RENEW}`;

    it('stops at a refused status read at once, with its code only, and the renew it advises converges', () => {
      installRecordingSleep(h);
      const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_FAIL_COMMANDS: 'get-command-invocation' }, '', 60_000);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! waiting for the command on the ops host failed (AccessDeniedException); ${UNKNOWN}`);
      expect(lines(h, 'sleeps.log')).toEqual([]);
      expectNoLeaks(h, r);

      // The command did create the login, as the log shows. Creating again
      // ends in "exists", with the secret on a password the login does not
      // have; renewing puts the two back in step.
      expect(opsLog(h)).toMatch(/^PERSON_RESULT=done\|/m);
      const createAgain = run(h, 'person-login.sh', ['create', HANDLE, '--yes']);
      expect(createAgain.status).toBe(1);
      expect(createAgain.stderr).toContain('the login already exists in the database');
      expect(scramMatches(role(h, LOGIN)!.verifier, secretValue(h, SECRET)!.password)).toBe(false);
      expect(run(h, 'person-login.sh', ['renew', HANDLE, '--yes']).status).toBe(0);
      expect(scramMatches(role(h, LOGIN)!.verifier, secretValue(h, SECRET)!.password)).toBe(true);
    });

    it.each<[string, Record<string, string>, string]>([
      ['a refused read of its output', { FAKE_FAIL_QUERIES: 'StandardOutputContent' }, "reading the command's result failed (AccessDeniedException)"],
      ['an output without its last line', { FAKE_SSM_OUTPUT_DROP: '^__JALE_PERSON_LOGIN_OK__$' }, 'the command on the ops host did not finish'],
      ['an output without its result', { FAKE_SSM_OUTPUT_DROP: '^PERSON_RESULT=' }, 'the command on the ops host reported no result'],
    ])('after %s, says the outcome is unknown and to check the log first; the renew it advises converges', (_name, env, head) => {
      const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! ${head}; its outcome is unknown. ${LOG_FIRST('create')} ${CREATE_OR_RENEW}`);
      expectNoLeaks(h, r);
      expect(opsLog(h)).toMatch(/^PERSON_RESULT=done\|/m);
      expect(run(h, 'person-login.sh', ['renew', HANDLE, '--yes']).status).toBe(0);
      expect(scramMatches(role(h, LOGIN)!.verifier, secretValue(h, SECRET)!.password)).toBe(true);
    });

    it('remove: an unknown outcome says to wait for that command, then remove again, which converges', () => {
      expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
      const r = run(h, 'person-login.sh', ['remove', HANDLE, '--yes'], { FAKE_FAIL_COMMANDS: 'get-command-invocation' }, '', 60_000);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! waiting for the command on the ops host failed (AccessDeniedException); its outcome is unknown. ${LOG_UNTIL('remove')} ${REMOVE_AGAIN}`);
      expect(r.stderr).not.toContain('person-login.sh renew');
      expect(secretMeta(h, SECRET)).toBeDefined();
      expectNoLeaks(h, r);

      const again = run(h, 'person-login.sh', ['remove', HANDLE, '--yes']);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('>> the login was not in the database');
      expect(role(h, LOGIN)).toBeUndefined();
      expect(secretMeta(h, SECRET)).toBeUndefined();
    });

    it('asks again while the invocation is not visible yet, then carries on', () => {
      installRecordingSleep(h);
      const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_SSM_INVISIBLE_READS: '2' }, '', 60_000);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`>> ${LOGIN} can sign in until 2026-11-04T12:00:00Z`);
      expect(lines(h, 'sleeps.log')).toEqual(['3', '3']);
    });

    it('gives up on a command that never finishes after the bounded wait, and says its outcome is unknown', () => {
      installRecordingSleep(h);
      installNeverFinishingOpsHost(h);
      const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], {}, '', 100_000);
      expect(r.status).toBe(1);
      const login = readTool('person-login.sh');
      const poll = Number(login.match(/^SSM_POLL_SECONDS=(\d+)$/m)![1]);
      const polls = Number(login.match(/^SSM_MAX_POLLS=(\d+)$/m)![1]);
      const minutes = Math.floor(((polls - 1) * poll) / 60);
      expect(r.stderr).toContain(`!! the command on the ops host did not finish after ${polls} status reads (at least ${minutes} minutes); ${UNKNOWN}`);
      expect(r.stderr).not.toContain('did not finish within');
      expect(lines(h, 'status-reads.log')).toHaveLength(2500);
      const sleeps = lines(h, 'sleeps.log');
      expect(sleeps).toHaveLength(2499);
      expect(new Set(sleeps)).toEqual(new Set(['3']));
      expectNoLeaks(h, r);
    });
  });

  it('a login renew may not change: says to remove it and create it again, and nothing else; doing so converges', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const r = run(h, 'person-login.sh', ['renew', HANDLE, '--yes'], { FAKE_REMOTE_FAIL: 'shape' });
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split('\n').pop()).toBe('!! the login does not have the personal-login shape; remove it, then create it again');
    expectNoLeaks(h, r);

    expect(run(h, 'person-login.sh', ['remove', HANDLE, '--yes']).status).toBe(0);
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    expect(scramMatches(role(h, LOGIN)!.verifier, secretValue(h, SECRET)!.password)).toBe(true);
  });

  it('reports an ops-host failure by its kind only', () => {
    const r = run(h, 'person-login.sh', ['create', HANDLE, '--yes'], { FAKE_REMOTE_FAIL: 'connect' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the ops host could not sign in to the database');
    expectNoLeaks(h, r);
  });

  it('remove: remove_person, then the secret is deleted; a missing login still deletes it; a failure keeps both', () => {
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const r = run(h, 'person-login.sh', ['remove', HANDLE, '--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('>> login removed (1 session(s) were open)');
    expect(r.stdout).toContain('>> secret deleted');
    expect(calls(h)[1].sql.trim()).toBe("CALL jale_ops.remove_person('tester1');");
    expect(role(h, LOGIN)).toBeUndefined();
    expect(secretMeta(h, SECRET)).toBeUndefined();
    expect(lines(h, 'deletes.log').map((l) => JSON.parse(l))).toEqual([{ id: SECRET, force: true }]);
    const ops = awsCalls(h).map((a) => a[1]);
    expect(ops.lastIndexOf('send-command')).toBeLessThan(ops.lastIndexOf('delete-secret'));
    expectNoLeaks(h, r);

    // Someone else's login, removed by another operator: no ownership needed.
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const byOther = run(h, 'person-login.sh', ['remove', HANDLE, '--yes'], { FAKE_CALLER_USERID: SOMEONE_ELSE });
    expect(byOther.status).toBe(0);
    expect(secretMeta(h, SECRET)).toBeUndefined();

    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    fs.rmSync(path.join(h.state, 'roles', `${LOGIN}.json`));
    const missing = run(h, 'person-login.sh', ['remove', HANDLE, '--yes']);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('>> the login was not in the database');
    expect(secretMeta(h, SECRET)).toBeUndefined();

    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
    const failed = run(h, 'person-login.sh', ['remove', HANDLE, '--yes'], { FAKE_REMOTE_FAIL: 'connect' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('the ops host could not sign in to the database; the login and its secret were kept');
    expect(role(h, LOGIN)).toBeDefined();
    expect(secretMeta(h, SECRET)).toBeDefined();
  });

  it('asks before changing anything, unless --yes', () => {
    const r = run(h, 'person-login.sh', ['create', HANDLE], {}, 'no\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('About to create the personal database login for handle tester1, valid for 30 day(s).');
    expect(secretMeta(h, SECRET)).toBeUndefined();
  });
});

describe('person-psql.sh and person-lookup.sh against the fakes', () => {
  jest.setTimeout(120_000);
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    expect(run(h, 'person-login.sh', ['create', HANDLE, '--yes']).status).toBe(0);
  });
  afterEach(() => {
    const pid = path.join(h.state, 'session.pid');
    if (fs.existsSync(pid)) {
      try { process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
    }
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  function sessionClosed(): boolean {
    return !fs.existsSync(path.join(h.state, 'session.pid')) && fs.existsSync(path.join(h.state, 'session.stopped'));
  }

  it('refuses psql older than 16 before any AWS call', () => {
    const before = awsCalls(h).length;
    const r = run(h, 'person-psql.sh', [HANDLE, '--check'], { FAKE_LOCAL_PSQL_MAJOR: '15' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('psql 16 or newer is required (found 15)');
    expect(awsCalls(h).length).toBe(before);
  });

  it('--check: the own secret, a port forward through the ops host, psql signed in by environment, and the forward closed', () => {
    const r = run(h, 'person-psql.sh', [HANDLE, '--check']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`>> signed in as ${LOGIN}; read-only by default: on; statement timeout: 30s\n`);
    expect(lines(h, 'sessions.log').map((l) => JSON.parse(l))).toEqual([{
      target: 'test-bastion-instance',
      document: 'AWS-StartPortForwardingSessionToRemoteHost',
      parameters: { host: ['db.test.invalid'], portNumber: ['5432'], localPortNumber: ['15432'] },
    }]);
    expect(lines(h, 'psql-env.log').map((l) => JSON.parse(l))).toEqual([{
      PGHOST: '127.0.0.1', PGPORT: '15432', PGUSER: LOGIN, PGDATABASE: 'jale', PGSSLMODE: 'require', password_set: true,
    }]);
    expect(sessionClosed()).toBe(true);
    // The host and the password never ride on a local command line.
    expect(localArgvText(h)).not.toContain('db.test.invalid');
    expectNoLeaks(h, r);
  });

  it('passes psql options through and keeps the forward up while psql runs', () => {
    const r = run(h, 'person-psql.sh', [HANDLE, '--local-port', '25432', '--'], {}, 'SELECT 1;\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('fake interactive psql session ended');
    expect(JSON.parse(lines(h, 'sessions.log')[0]).parameters.localPortNumber).toEqual(['25432']);
    expect(sessionClosed()).toBe(true);
  });

  it('reports a forward that does not open by its error code only', () => {
    const r = run(h, 'person-psql.sh', [HANDLE, '--check'], { FAKE_SESSION_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the port forward did not open (TargetNotConnected)');
    expectNoLeaks(h, r);
  });

  it('says to renew when the database refuses the password', () => {
    const f = path.join(h.state, 'secrets', SECRET.replace(/\//g, '__'));
    const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
    meta.value = JSON.stringify({ username: LOGIN, password: 'Stale0passwordxxxxxxxxxxxxxxxxxxxxxxxxx' });
    fs.writeFileSync(f, JSON.stringify(meta));
    const r = run(h, 'person-psql.sh', [HANDLE, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the database refused your password; renew your login with scripts/ops/person-login.sh renew tester1');
    expect(r.stderr).not.toContain('Stale0password');
    expect(sessionClosed()).toBe(true);
  });

  const VALUE = "someone+tag@example.test ' \\ $(touch /tmp/x)";
  const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  it('person-lookup: the value only on psql\'s stdin, bound, never in argv or output; the id only', () => {
    const r = run(h, 'person-lookup.sh', [HANDLE, 'email'], { FAKE_LOOKUP: JSON.stringify({ [VALUE]: ID }) }, `${VALUE}\n`);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`user id: ${ID}\n`);
    expect(lines(h, 'lookups.log').map((l) => JSON.parse(l))).toEqual([
      { kind: 'email', sha256: crypto.createHash('sha256').update(VALUE).digest('hex') },
    ]);
    expect(argvText(h)).not.toContain('someone+tag');
    expect(r.stdout + r.stderr).not.toContain('someone+tag');
    expect(sessionClosed()).toBe(true);
    expectNoLeaks(h, r);
  });

  it('person-lookup: no match, several matches, and a bad kind', () => {
    const none = run(h, 'person-lookup.sh', [HANDLE, 'phone'], { FAKE_LOOKUP: '{}' }, '+1 555 010 0000\n');
    expect(none.status).toBe(0);
    expect(none.stdout).toBe('no user matches\n');
    const many = run(h, 'person-lookup.sh', [HANDLE, 'whatsapp'], { FAKE_LOOKUP: JSON.stringify({ '+1 555 010 0000': 'MANY' }) }, '+1 555 010 0000\n');
    expect(many.status).toBe(1);
    expect(many.stderr).toBe('!! more than one user matches; look the user up by another kind\n');
    const before = awsCalls(h).length;
    const kind = run(h, 'person-lookup.sh', [HANDLE, 'name'], {}, 'x\n');
    expect(kind.status).toBe(2);
    expect(run(h, 'person-lookup.sh', [HANDLE, 'email'], {}, '').status).toBe(1);
    expect(awsCalls(h).length).toBe(before);
  });
});
