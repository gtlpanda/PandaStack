# AWS Architecture Review

Review AWS architecture against the AWS Well-Architected Framework (6 pillars) and production-ready patterns from "AWS for Solutions Architects" (3rd Edition, 2025).

Use this skill when the user says "review my AWS architecture", "AWS review", "well-architected review", "WAR", "is my AWS architecture good", "audit my AWS", "check my infra", or provides Terraform/CloudFormation/CDK code targeting AWS.

## How to Execute

### Step 1: Gather Context

Before reviewing, identify the scope. Read all relevant infrastructure files in the project (Terraform, CloudFormation, CDK, Pulumi, serverless.yml, docker-compose, architecture docs, etc.). Use the Explore agent if needed to find all AWS-related configuration.

Ask the user (via AskUserQuestion) ONLY if critical context is missing:
- What is the workload type? (web app, API, data pipeline, ML, etc.)
- What is the criticality? (dev/staging/production, mission-critical?)
- What compliance requirements exist? (HIPAA, SOC2, PCI-DSS, none?)

If the user provided a description or the codebase makes it clear, skip the questions and proceed.

### Step 2: Review Across All Six Pillars

For EACH pillar, launch a parallel background subagent (6 total) to audit the architecture. Each subagent should read the relevant infra files and evaluate against the criteria below.

---

## PILLAR 1: OPERATIONAL EXCELLENCE

**Design Principles:**
- Organize teams around business outcomes
- Implement observability for actionable insights (metrics, logs, traces)
- Safely automate where possible (operations as code)
- Make frequent, small, reversible changes
- Refine operations procedures frequently
- Anticipate failure (pre-mortems, game days)
- Learn from all operational events and metrics
- Use managed services to reduce operational burden

**Review Questions (OPS 1-11):**
- OPS 1: How do you determine priorities? (shared business goals)
- OPS 2: How do you structure your organization? (ownership, responsibility)
- OPS 3: How does organizational culture support outcomes? (experimentation, learning)
- OPS 4: How do you implement observability? (CloudWatch, X-Ray, CloudTrail, structured logging)
- OPS 5: How do you reduce defects and improve flow? (CI/CD pipelines, code reviews, automated testing)
- OPS 6: How do you mitigate deployment risks? (blue/green, canary, rollback strategies)
- OPS 7: Are you ready to support the workload? (runbooks, playbooks, operational readiness reviews)
- OPS 8: How do you utilize workload observability? (dashboards, alarms, anomaly detection)
- OPS 9: How do you understand operations health? (operations metrics, KPIs)
- OPS 10: How do you manage workload and operations events? (event management, escalation)
- OPS 11: How do you evolve operations? (continuous improvement, feedback loops)

**Check for:**
- [ ] IaC (CloudFormation/Terraform/CDK) for all resources - no ClickOps
- [ ] CI/CD pipeline defined (CodePipeline, GitHub Actions, etc.)
- [ ] CloudWatch alarms on key metrics
- [ ] X-Ray or distributed tracing enabled
- [ ] Structured logging (JSON) to CloudWatch Logs
- [ ] Resource tagging strategy (cost center, environment, owner)
- [ ] Deployment strategy (blue/green, canary, rolling)
- [ ] Rollback capability
- [ ] Runbook/playbook documentation or references

---

## PILLAR 2: SECURITY

**Design Principles:**
- Implement a strong identity foundation (least privilege, centralized identity)
- Maintain traceability (audit all actions in real time)
- Apply security at all layers (edge, VPC, subnet, instance, OS, application, code)
- Automate security best practices (security as code)
- Protect data in transit and at rest (encryption, tokenization)
- Keep people away from data (reduce direct access)
- Prepare for security events (incident response, game days)

**Review Questions (SEC 1-11):**
- SEC 1: How do you securely operate? (AWS Organizations, SCPs, security baselines)
- SEC 2: How do you manage identities? (IAM Identity Center, federation, MFA)
- SEC 3: How do you manage permissions? (least privilege, IAM policies, resource policies)
- SEC 4: How do you detect and investigate events? (GuardDuty, CloudTrail, Security Hub, Detective)
- SEC 5: How do you protect network resources? (VPC, security groups, NACLs, WAF, Shield)
- SEC 6: How do you protect compute resources? (hardened AMIs, patching, Inspector)
- SEC 7: How do you classify data? (data classification, sensitivity levels)
- SEC 8: How do you protect data at rest? (KMS, SSE, encryption by default)
- SEC 9: How do you protect data in transit? (TLS, ACM certificates, VPC endpoints)
- SEC 10: How do you anticipate and respond to incidents? (incident response plan, forensics)
- SEC 11: How do you validate security in the SDLC? (AppSec, threat modeling, dependency scanning)

**Check for:**
- [ ] No hardcoded secrets, credentials, or access keys in code
- [ ] IAM roles (not users) for services; no wildcard (*) permissions
- [ ] MFA enforced on root and IAM users
- [ ] Encryption at rest on all data stores (S3 SSE, EBS encryption, RDS encryption)
- [ ] Encryption in transit (TLS everywhere, ACM certificates)
- [ ] VPC with private subnets for databases/internal services
- [ ] Security groups follow least-privilege (no 0.0.0.0/0 on SSH/RDP)
- [ ] GuardDuty enabled
- [ ] CloudTrail enabled in all regions
- [ ] WAF on public-facing ALBs/CloudFront
- [ ] Secrets Manager or Parameter Store for secrets (not environment variables)
- [ ] S3 buckets: public access blocked, versioning enabled
- [ ] AWS Config rules for compliance monitoring

---

## PILLAR 3: RELIABILITY

**Design Principles:**
- Automatically recover from failure (KPI-driven automation)
- Test recovery procedures (chaos engineering, failure injection)
- Scale horizontally to increase availability (distribute load)
- Stop guessing capacity (auto-scaling, monitoring)
- Manage change through automation (IaC, deployment pipelines)

**Review Questions (REL 1-13):**
- REL 1: How do you manage Service Quotas? (quota monitoring, limit increases)
- REL 2: How do you plan network topology? (multi-AZ, VPC design, DNS)
- REL 3: How do you design service architecture? (SOA/microservices, loose coupling)
- REL 4: How do you prevent failures in distributed systems? (retries, circuit breakers, timeouts)
- REL 5: How do you withstand failures? (graceful degradation, bulkhead pattern)
- REL 6: How do you monitor resources? (health checks, CloudWatch, alarms)
- REL 7: How do you adapt to demand changes? (Auto Scaling, elasticity)
- REL 8: How do you implement change? (controlled deployments, change management)
- REL 9: How do you back up data? (automated backups, AWS Backup, cross-region)
- REL 10: How do you use fault isolation? (AZ isolation, cell-based architecture)
- REL 11: How do you withstand component failures? (redundancy, health checks, failover)
- REL 12: How do you test reliability? (fault injection, game days, chaos engineering)
- REL 13: How do you plan for DR? (RTO/RPO targets, multi-region, pilot light/warm standby)

**Check for:**
- [ ] Multi-AZ deployment for databases (RDS Multi-AZ, Aurora)
- [ ] Auto Scaling groups with proper min/max/desired
- [ ] Health checks on load balancers and targets
- [ ] Dead letter queues (DLQ) on SQS/Lambda
- [ ] Circuit breaker patterns for external dependencies
- [ ] Retry logic with exponential backoff and jitter
- [ ] Automated backups enabled (RDS, DynamoDB PITR, EBS snapshots)
- [ ] Cross-region replication for critical data
- [ ] DR strategy defined (backup/restore, pilot light, warm standby, active-active)
- [ ] RTO and RPO documented and tested
- [ ] No single points of failure (single AZ, single instance)
- [ ] Service Quotas reviewed and increased where needed

---

## PILLAR 4: PERFORMANCE EFFICIENCY

**Design Principles:**
- Democratize advanced technologies (use managed services)
- Go global in minutes (multi-region, CloudFront, edge)
- Use serverless architectures where appropriate
- Experiment more often (A/B test instance types, configurations)
- Consider mechanical sympathy (match technology to workload)

**Review Questions (PERF 1-5):**
- PERF 1: How do you select architecture patterns? (purpose-built, multiple approaches)
- PERF 2: How do you select compute? (instances vs containers vs Lambda)
- PERF 3: How do you store and access data? (purpose-built storage, caching)
- PERF 4: How do you select networking? (CloudFront, Global Accelerator, VPC endpoints)
- PERF 5: What process supports performance efficiency? (benchmarking, load testing, metrics)

**Check for:**
- [ ] Right-sized compute (not over-provisioned instances)
- [ ] Graviton instances considered for cost-performance
- [ ] Caching layer where appropriate (ElastiCache, DAX, CloudFront)
- [ ] Purpose-built databases (DynamoDB for key-value, Aurora for relational, etc.)
- [ ] CloudFront for static content delivery
- [ ] VPC endpoints for AWS service access (avoid NAT Gateway costs for S3/DynamoDB)
- [ ] Connection pooling (RDS Proxy for Lambda-to-RDS)
- [ ] Async processing where possible (SQS, EventBridge, Step Functions)
- [ ] Read replicas for read-heavy workloads
- [ ] S3 storage classes optimized (Intelligent-Tiering, lifecycle policies)
- [ ] Load testing evidence or plan

---

## PILLAR 5: COST OPTIMIZATION

**Design Principles:**
- Implement Cloud Financial Management (FinOps)
- Adopt a consumption model (pay for what you use)
- Measure overall efficiency (business output per dollar)
- Stop spending on undifferentiated heavy lifting (use managed services)
- Analyze and attribute expenditure (tagging, cost allocation)

**Review Questions (COST 1-11):**
- COST 1: How do you implement cloud financial management? (CFM team, processes)
- COST 2: How do you govern usage? (budgets, SCPs, quotas)
- COST 3: How do you monitor usage and cost? (Cost Explorer, CUR, budgets/alerts)
- COST 4: How do you decommission resources? (lifecycle management, cleanup)
- COST 5: How do you evaluate cost when selecting services? (managed vs self-managed)
- COST 6: How do you meet cost targets with resource type/size/number? (right-sizing)
- COST 7: How do you use pricing models? (Savings Plans, Reserved Instances, Spot)
- COST 8: How do you plan for data transfer charges? (architecture to minimize transfer)
- COST 9: How do you manage demand and supply? (Auto Scaling, throttling, queues)
- COST 10: How do you evaluate new services? (regular reviews of new AWS offerings)
- COST 11: How do you evaluate the cost of effort? (automation vs manual operations)

**Check for:**
- [ ] Resource tagging for cost allocation
- [ ] AWS Budgets / billing alerts configured
- [ ] Savings Plans or Reserved Instances for steady-state workloads
- [ ] Spot Instances for fault-tolerant workloads (batch, CI/CD)
- [ ] Right-sized instances (Compute Optimizer recommendations)
- [ ] S3 lifecycle policies (transition to IA/Glacier)
- [ ] Dev/staging environments with auto-shutdown schedules
- [ ] NAT Gateway costs minimized (VPC endpoints, architecture review)
- [ ] Data transfer costs considered (same-AZ, VPC endpoints, CloudFront)
- [ ] No orphaned resources (unused EBS volumes, old snapshots, idle EIPs)
- [ ] Serverless for variable/spiky workloads (Lambda vs always-on EC2)

---

## PILLAR 6: SUSTAINABILITY

**Design Principles:**
- Understand your impact (measure resource consumption per unit of work)
- Establish sustainability goals (reduce resources per transaction)
- Maximize utilization (right-size, avoid idle resources)
- Anticipate and adopt efficient hardware/software offerings
- Use managed services (shared infrastructure, higher utilization)
- Reduce downstream impact

**Review Questions (SUS 1-6):**
- SUS 1: How do you select Regions? (carbon footprint, renewable energy, latency)
- SUS 2: How do you align resources to demand? (auto-scaling, right-sizing)
- SUS 3: How do you leverage software/architecture patterns? (efficient code, consolidation)
- SUS 4: How do you manage data sustainably? (lifecycle, compression, deduplication)
- SUS 5: How do you select hardware/services? (Graviton, managed services, serverless)
- SUS 6: How do your processes support sustainability? (efficient builds, scheduled environments)

**Check for:**
- [ ] Graviton-based instances where possible (better performance per watt)
- [ ] Auto Scaling to match demand (no permanent over-provisioning)
- [ ] Serverless/managed services preferred over self-managed
- [ ] Data lifecycle policies (delete what you don't need)
- [ ] Efficient Region selection
- [ ] Build environment optimization (Spot for CI, scheduled dev teardown)

---

## ADDITIONAL SOLUTIONS ARCHITECT PATTERNS (from "AWS for Solutions Architects")

Beyond the 6 pillars, evaluate these architectural patterns:

### Networking Architecture
- VPC design: public/private subnet separation, proper CIDR planning
- Transit Gateway for multi-VPC connectivity (vs VPC peering for simple cases)
- PrivateLink for service-to-service communication
- Route 53 health checks and DNS failover
- CloudFront with proper cache behaviors and origin failover
- Network Firewall or third-party for advanced inspection

### Database Selection
- Purpose-built databases (don't use RDS for everything)
- DynamoDB for key-value/document with single-digit ms latency
- Aurora for relational with high availability requirements
- ElastiCache/MemoryDB for caching and session management
- Redshift for analytics/data warehousing
- Neptune for graph data, Timestream for time-series
- RDS Proxy for serverless-to-relational connectivity

### Microservices & Event-Driven Architecture
- API Gateway pattern for service entry points
- Circuit breaker pattern for resilience
- Event-driven with EventBridge, SQS, SNS, Kinesis
- Domain-driven design for service boundaries
- Async communication preferred over synchronous chains
- Dead letter queues for failed event processing
- Step Functions for orchestration of complex workflows

### Data Engineering & Analytics
- Data lake on S3 with proper zone architecture (raw/curated/published)
- Lake Formation for governance
- Glue for ETL, Athena for ad-hoc queries
- Kinesis/MSK for streaming data ingestion
- Redshift for structured analytics
- QuickSight for visualization

### Migration Patterns (7 Rs)
- Rehost (lift-and-shift), Replatform, Refactor, Repurchase, Relocate, Retain, Retire
- MGN for server migration, DMS for database migration
- Cloud Adoption Framework (CAF) alignment

### ML/GenAI Architecture
- SageMaker for custom ML workflows
- Bedrock for foundation model access
- Graviton/Inferentia/Trainium for cost-efficient inference/training
- MLOps pipeline for model lifecycle management

---

## Step 3: Synthesize and Report

After all subagent results return, produce a structured report:

```
# AWS Well-Architected Review

## Architecture Summary
[Brief description of the workload and its components]

## Pillar Scores

| Pillar | Score | Critical Issues | Recommendations |
|--------|-------|-----------------|-----------------|
| Operational Excellence | HIGH/MEDIUM/LOW risk | count | count |
| Security | HIGH/MEDIUM/LOW risk | count | count |
| Reliability | HIGH/MEDIUM/LOW risk | count | count |
| Performance Efficiency | HIGH/MEDIUM/LOW risk | count | count |
| Cost Optimization | HIGH/MEDIUM/LOW risk | count | count |
| Sustainability | HIGH/MEDIUM/LOW risk | count | count |

## Critical Findings (Must Fix)
[Numbered list with file:line references, severity, and remediation]

## High-Priority Recommendations
[Numbered list with concrete actions]

## Medium-Priority Improvements
[Numbered list]

## Architecture Patterns Assessment
[Evaluation of service selection, networking, data patterns]

## What's Working Well
[Positive findings to acknowledge]
```

### Severity Classification:
- **CRITICAL**: Security vulnerabilities, data loss risk, compliance violations, single points of failure in production
- **HIGH**: Missing encryption, no backups, no monitoring, over-permissive IAM
- **MEDIUM**: Missing optimization, no caching, suboptimal service selection
- **LOW**: Nice-to-have improvements, sustainability enhancements

### Rules:
1. Always provide file:line references for findings
2. Give concrete remediation steps, not vague advice
3. Include specific AWS service recommendations
4. Flag one-way doors (decisions hard to reverse) prominently
5. Acknowledge what's done well -- this is a conversation, not just criticism
6. Prioritize findings by blast radius and likelihood
7. For each critical finding, explain the real-world consequence of not fixing it
