# AWSome security ruleset

The catalogue of checks AWSome runs, or should run, against an AWS account.

Rules are grouped by the thing an attacker is actually after, not by AWS service,
because that is how exposure compounds: a public bucket is bad, a public bucket
holding CloudTrail logs is worse, and a public bucket holding CloudTrail logs in
an account with no GuardDuty is how a breach goes unnoticed for a year.

**Status legend**

| mark | meaning |
| --- | --- |
| `[x]` | implemented and exercised by tests |
| `[~]` | partially implemented — detects the condition but not every variant |
| `[ ]` | catalogued, not yet implemented (data not collected, or rule not written) |

**Severity model**

| severity | meaning |
| --- | --- |
| `critical` | directly reachable from the internet or grants account-wide control; assume compromise if present |
| `high` | a meaningful step on an attack path — needs another condition to be exploitable |
| `medium` | weakens containment, detection or recovery; not directly exploitable |
| `low` | hygiene, cost, or governance; real but not a breach path |

Compliance references are to **CIS AWS Foundations Benchmark v3.0.0** and
**NIST SP 800-53 Rev. 5** control families. They are a navigation aid, not a
certification: verify against your own FedRAMP/agency baseline before citing them
in an audit. Where a mapping is approximate it is marked *(approx)*.

---

## 1. Identity and access

The highest-value target. Almost every real breach path runs through a credential
or a trust relationship, not a network port.

| rule | status | sev | detects | why it matters | ref |
| --- | --- | --- | --- | --- | --- |
| `iam-wildcard-admin` | `[x]` | critical/high | customer-managed policy granting `Action:"*"`, critical when `Resource:"*"` too | anyone holding it is an account administrator | CIS 1.16 |
| `iam-trust-wildcard` | `[x]` | critical/medium | role trust policy with `Principal:"*"`; medium if a `Condition` narrows it | any AWS principal on earth can assume the role | AC-3 |
| `iam-cross-account-trust` | `[x]` | high | trust policy naming an external account with no `ExternalId`/`PrincipalOrgID` | confused-deputy; a third party can assume your role | AC-3 |
| `iam-root-access-key` | `[x]` | critical | access key on the root account | root keys cannot be scoped or easily rotated | CIS 1.4 |
| `iam-root-recent-use` | `[ ]` | high | root credential used recently | root should be break-glass only | CIS 1.7 |
| `iam-user-no-mfa` | `[x]` | high | console-enabled user without MFA | password spray/phish leads straight to access | CIS 1.10 |
| `iam-access-key-stale` | `[x]` | medium | active access key older than 90 days | long-lived static credential, the most commonly leaked secret | CIS 1.14 |
| `iam-access-key-unused` | `[x]` | medium | active key unused for 90+ days | standing credential nobody would notice being used | CIS 1.12 |
| `iam-user-two-keys` | `[x]` | low | user with two active access keys | doubles exposure, usually a stalled rotation | CIS 1.13 |
| `iam-weak-password-policy` | `[x]` | medium | min length < 14, or no reuse prevention | brute-force and credential-stuffing resistance | CIS 1.8, 1.9 |
| `iam-password-reuse` | `[x]` | low | password policy not preventing reuse of the last 24 | credential-stuffing resistance | CIS 1.9 |
| `iam-privesc-pattern` | `[ ]` | critical | `iam:PassRole` with `*`, or `iam:CreatePolicyVersion`/`AttachUserPolicy` unscoped | a low-privilege principal can escalate to admin | AC-6 |
| `iam-inline-admin` | `[ ]` | high | inline policy on user/role granting `*:*` | inline policies escape policy-level review | CIS 1.16 |
| `iam-user-direct-policy` | `[ ]` | low | policy attached to a user rather than a group/role | drifts from the intended permission model | CIS 1.15 |
| `iam-unused-role` | `[ ]` | low | role not assumed in 90+ days | standing trust with no owner | AC-2 |
| `access-analyzer-disabled` | `[ ]` | medium | no IAM Access Analyzer in the region | external-access findings go undetected | CIS 1.20 |

**Why this section came first:** a stale access key in a CI config is a likelier
entry point than any misconfigured security group. The `iam-credentials` walker
was added specifically to cover it — users, access keys, MFA state and the
password policy, none of which the scanner previously read.

The remaining gap worth closing next is `iam-privesc-pattern`. Wildcard
`iam:PassRole` is how a "read-only" role quietly becomes an admin one, and the
policy documents needed to detect it are already collected.

---

## 2. Network exposure

| rule | status | sev | detects | why it matters | ref |
| --- | --- | --- | --- | --- | --- |
| `sg-open-ingress` | `[x]` | critical→low | `0.0.0.0/0`/`::/0` ingress, graded by port | SSH/RDP/DB from anywhere is direct exposure; 443 on an ALB is normal | CIS 5.2 |
| `sg-open-egress-all` | `[x]` | low | unrestricted egress to `0.0.0.0/0` | enables exfiltration and C2 callback | SC-7 |
| `sg-default-in-use` | `[ ]` | medium | default security group with rules, or attached to resources | default SGs should deny everything | CIS 5.3 |
| `sg-orphan` | `[x]` | low | SG attached to nothing | hygiene; also hides intent | — |
| `nacl-open-admin` | `[ ]` | high | NACL allowing `0.0.0.0/0` to 22/3389 | subnet-wide exposure beneath the SG layer | CIS 5.1 |
| `ec2-public-ip` | `[x]` | medium | instance with a public IP | every public IP is attack surface that needs justifying | SC-7 |
| `rds-publicly-accessible` | `[x]` | critical | RDS instance with `publicly_accessible=true` | database reachable from the internet | CIS 2.3.3 |
| `elb-http-listener` | `[ ]` | high | listener on HTTP without redirect to HTTPS | credentials and sessions in cleartext | SC-8 |
| `elb-weak-tls-policy` | `[ ]` | medium | TLS policy permitting TLS 1.0/1.1 | downgrade and known cipher attacks | SC-8 |
| `eks-public-endpoint` | `[x]` | critical | EKS API server endpoint public, especially `0.0.0.0/0` | Kubernetes API exposed to the internet | SC-7 |
| `opensearch-public` | `[ ]` | critical | domain without VPC placement / open access policy | classic mass-exploitation target | SC-7 |
| `redshift-public` | `[ ]` | high | cluster `PubliclyAccessible` | data warehouse exposed | SC-7 |
| `elasticache-no-auth` | `[ ]` | high | Redis without AUTH/transit encryption | unauthenticated cache access | IA-2 |
| `lambda-public-url` | `[ ]` | critical | function URL with `AuthType: NONE` | unauthenticated code execution endpoint | AC-3 |
| `lambda-public-policy` | `[ ]` | high | resource policy allowing `*` invoke | same, via the policy route | AC-3 |
| `vpc-peering-broad-route` | `[ ]` | medium | route table sending a wide CIDR across a peering link | lateral movement between environments | CIS 5.4 |
| `cross-env-edge` | `[x]` | high | traffic edge between resources tagged with different `env` | prod/non-prod blast-radius bleed | SC-7 |

---

## 3. Data protection

| rule | status | sev | detects | why it matters | ref |
| --- | --- | --- | --- | --- | --- |
| `s3-public-bucket` | `[x]` | critical→low | anonymous grant via ACL or policy; downgraded when `Condition`-scoped or blocked by BPA | the single most common source of public data leaks | CIS 2.1.4 |
| `s3-bpa-off` | `[x]` | high | Block Public Access not fully enabled | removes the backstop that makes a policy mistake harmless | CIS 2.1.4 |
| `s3-no-encryption` | `[x]` | medium | no default SSE configured | at-rest protection absent | CIS 2.1.1 |
| `s3-no-secure-transport` | `[x]` | medium | no policy denying non-TLS access | permits plaintext object reads | CIS 2.1.2 |
| `s3-no-versioning` | `[x]` | medium | versioning disabled | ransomware/overwrite has no recovery path | CP-9 |
| `s3-no-access-logging` | `[x]` | low | server access logging disabled | no record of who read what | AU-2 |
| `unencrypted-storage` | `[x]` | medium | EBS/RDS/Redshift with `encrypted=false` | at-rest protection absent | CIS 2.2.1, 2.3.1 |
| `ebs-default-encryption-off` | `[ ]` | medium | account-level EBS default encryption disabled | every new volume starts unencrypted | CIS 2.2.1 |
| `snapshot-public` | `[ ]` | critical | EBS or RDS snapshot shared publicly | a full copy of your data, downloadable | AC-3 |
| `rds-no-backup` | `[x]` | high | backup retention 0, or under policy minimum | no recovery from corruption or ransomware | CP-9 |
| `rds-no-deletion-protection` | `[x]` | medium | deletion protection off on a production database | one API call from data loss | CP-9 |
| `rds-no-minor-upgrade` | `[x]` | low | auto minor version upgrade disabled | known CVEs stay unpatched | SI-2, CIS 2.3.2 |
| `dynamodb-no-pitr` | `[ ]` | medium | point-in-time recovery disabled | no rollback after bad writes | CP-9 |
| `kms-no-rotation` | `[ ]` | medium | customer-managed CMK without annual rotation | extends the blast radius of a key compromise | CIS 3.8 |
| `secret-no-rotation` | `[ ]` | medium | Secrets Manager secret with rotation disabled | static secrets age into liabilities | IA-5 |
| `lambda-env-secret` | `[x]` | high | env var whose **name** suggests a secret (`*SECRET*`, `*PASSWORD*`, `*TOKEN*`, `*_KEY`) | plaintext secrets readable by anyone with `lambda:GetFunction` | IA-5 |
| `ecr-scan-disabled` | `[x]` | medium | repository without scan-on-push | vulnerable images ship unnoticed | RA-5 |
| `ecr-mutable-tags` | `[x]` | low | mutable image tags | an audited tag can be silently replaced | CM-3 |
| `ecr-public-policy` | `[ ]` | high | repository policy allowing `*` | images (and embedded secrets) publicly pullable | AC-3 |

> **Collection note:** `lambda-env-secret` must record environment variable
> **names only, never values** — otherwise the scanner writes the very secrets it
> is auditing into `snapshots/` on disk.

---

## 4. Compute and workload

| rule | status | sev | detects | why it matters | ref |
| --- | --- | --- | --- | --- | --- |
| `ec2-imdsv1-enabled` | `[x]` | **critical** | instance metadata `HttpTokens: optional` | a single SSRF in an app becomes full credential theft of the instance role — this is how Capital One happened | AC-6, SC-7 |
| `ec2-imds-hop-limit` | `[x]` | medium | metadata hop limit > 1 on a container host | lets containers reach the host's credentials | AC-6 |
| `ec2-no-instance-profile` | `[ ]` | low | instance with no role, implying static keys on disk | static credentials never rotate | IA-5 |
| `ec2-stopped` | `[x]` | medium | stopped instance still incurring EBS cost | cost and unpatched drift | — |
| `lambda-eol-runtime` | `[x]` | high | runtime past AWS end-of-support | no security patches from AWS | SI-2 |
| `lambda-no-vpc` | `[ ]` | low | function outside a VPC when peers are inside | inconsistent egress control | SC-7 |
| `ecs-privileged-task` | `[ ]` | high | task definition with `privileged: true` | container escape to the host | CM-7 |
| `ecs-secret-in-env` | `[ ]` | high | secrets in task definition `environment` instead of `secrets` | visible in the console and API | IA-5 |
| `ecs-no-readonly-rootfs` | `[ ]` | low | writable container root filesystem | eases persistence after compromise | CM-7 |
| `eks-no-audit-logging` | `[ ]` | medium | control-plane audit logging disabled | no record of Kubernetes API activity | AU-2 |
| `eks-outdated-version` | `[ ]` | medium | cluster on an unsupported Kubernetes version | unpatched control plane | SI-2 |
| `ami-public` | `[ ]` | high | AMI shared publicly | AMIs routinely contain keys and source | AC-3 |

---

## 5. Logging, detection and response

Controls here do not stop an intrusion — they decide whether you ever find out.

| rule | status | sev | detects | why it matters | ref |
| --- | --- | --- | --- | --- | --- |
| `cloudtrail-absent` | `[ ]` | critical | no trail covering the region | no audit record at all | CIS 3.1 |
| `cloudtrail-not-multiregion` | `[ ]` | high | trail limited to one region | activity in other regions is invisible | CIS 3.1 |
| `cloudtrail-no-validation` | `[ ]` | medium | log file validation disabled | logs can be altered undetectably | CIS 3.2 |
| `cloudtrail-not-encrypted` | `[ ]` | medium | trail not using SSE-KMS | log confidentiality | CIS 3.7 |
| `cloudtrail-bucket-public` | `[ ]` | critical | the trail's own S3 bucket is public | hands an attacker the audit trail | CIS 3.3 |
| `cloudtrail-no-cwl` | `[ ]` | low | not delivering to CloudWatch Logs | no real-time alerting path | CIS 3.4 |
| `vpc-flow-logs-disabled` | `[x]` | medium | VPC without flow logs | no network forensics after an incident | CIS 3.9 |
| `config-disabled` | `[ ]` | medium | AWS Config recorder absent | no configuration history to investigate | CIS 3.5 |
| `guardduty-disabled` | `[ ]` | high | GuardDuty not enabled in the region | the primary managed threat detection is off | SI-4 |
| `securityhub-disabled` | `[ ]` | low | Security Hub not enabled | no aggregated posture view | CA-7 |
| `no-log-retention` | `[ ]` | low | CloudWatch log group with unlimited or very short retention | either cost sprawl or evidence loss | AU-11 |

---

## 6. Resilience

Not "security" in the narrow sense, but the recovery half of an incident.

| rule | status | sev | detects | ref |
| --- | --- | --- | --- | --- |
| `rds-single-az` | `[ ]` | low | production database without Multi-AZ | CP-10 |
| `no-backup-plan` | `[ ]` | medium | resource not covered by any AWS Backup plan | CP-9 |
| `asg-single-az` | `[ ]` | low | ASG confined to one availability zone | CP-10 |
| `elb-no-deletion-protection` | `[ ]` | low | load balancer without deletion protection | CP-10 |

---

## 7. Governance and hygiene

Weak signals individually; together they show whether anyone owns the account.

| rule | status | sev | detects |
| --- | --- | --- | --- |
| `missing-tags` | `[x]` | low | missing `Environment`/`Name` on tag-collecting labels |
| `eip-unassociated` | `[x]` | medium | allocated but unattached Elastic IP (billable) |
| `eni-unattached` | `[x]` | low | ENI genuinely in `available` state |
| `untagged-owner` | `[ ]` | low | no `Owner`/`CostCenter` tag |
| `resource-drift` | `[x]` | — | snapshot-to-snapshot change, attributed to a CloudTrail principal |

---

## Rule quality standards

Learned the hard way on a real account, where the first run produced 195 findings
of which roughly half were noise:

1. **A rule must distinguish "not configured" from "not collected."** Flagging
   missing tags on resources whose walker never calls the tag API reports a
   scanner gap as a customer problem. Gate rules on labels where the data is
   actually gathered.
2. **Parse structure, never substring-match policy documents.** `"*"` appears in
   wildcard actions and resources, and substring matching cannot see a
   `Condition`. A bucket scoped to CloudFront edge IPs is not public.
3. **Grade by exposure, not by pattern.** `0.0.0.0/0` on 443 for an internet-facing
   ALB is the design; on 22 it is an incident. One rule, different severities.
4. **Respect overriding controls.** S3 Block Public Access neutralises a public
   policy; a `Condition` narrows a wildcard principal. Reflect that in severity
   rather than emitting a finding the operator has to re-litigate.
5. **Every finding carries evidence and a remediation.** A finding an engineer
   cannot act on is noise with a severity attached.
6. **Never collect a secret to report on it.** Record that a secret-shaped
   environment variable exists; never record its value.

## Coverage gaps

Services with no walker at all, so nothing in this catalogue can fire for them:
CloudFront, Route 53, WAF, API Gateway, ACM, SNS, SQS, Step Functions, EFS,
Secrets Manager, SSM Parameter Store, Organizations/SCPs, Systems Manager patch
state, VPC endpoints (their ENIs are seen, the endpoints themselves are not).
