# 0001 Identity: tables, roles and how access is granted

Date: 2026-11-18. Service: identity (generic tier).

Memberships were later folded into users: see 0003.

Identity answers who may do what in which tenant and program, and which programs a tenant has enabled. The design documents leave its tables, roles and access model open. Three choices settle them.

## 1. Tables
Options: A, minimal (tenants, users, memberships, role assignments, enabled programs); B, A plus invitations as their own table; C, B plus API keys or service accounts for feeds.

**Decided: B.** Invitations exist in the current system and are needed for onboarding. Service accounts wait for a real need.

## 2. Roles
Options: A, fixed roles in code; B, roles stored as data that each tenant edits; C, fixed roles now, with permissions kept as named checks so B stays possible.

**Decided: C.** It matches the current system's roles and permissions, and nothing in the design needs tenant-editable roles yet.

## 3. How access is granted
Options: A, a role applies to every program in the tenant; B, each membership lists the programs it may use; C, a tenant role plus an optional program restriction, where no restriction means all programs.

**Decided: C.** Rule 6 already scopes data by tenant and program, and most users need no restriction.

## Also settled
The platform role SYSTEM_ADMIN stays outside tenants. Every use of it is written to Audit.

## Revisit when
A customer needs roles of their own (move to option B for roles), or a feed needs its own credentials (add service accounts).
