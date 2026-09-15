import React, { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useReactFlow, Background, Controls, MiniMap, MarkerType, Handle, Position } from "@xyflow/react";
import dagre from "dagre";
import { marked } from "marked";
import DOMPurify from "dompurify";

/* ---------- official AWS Architecture Icons ----------
 * @aws-icons/react (MIT) packages AWS's published Architecture Icon set as React
 * components. Pinned to react@18.3.1 via ?deps so esm.sh does not pull a second
 * React copy (that would break hooks). Each import is a separate module, so only
 * the icons listed here are fetched — not all 700+.
 */
import IconEc2 from "@aws-icons/react/architecture-service/amazon-ec2";
import IconS3 from "@aws-icons/react/architecture-service/amazon-simple-storage-service";
import IconRds from "@aws-icons/react/architecture-service/amazon-rds";
import IconLambda from "@aws-icons/react/architecture-service/aws-lambda";
import IconDynamo from "@aws-icons/react/architecture-service/amazon-dynamo-db";
import IconElastiCache from "@aws-icons/react/architecture-service/amazon-elasti-cache";
import IconEcs from "@aws-icons/react/architecture-service/amazon-elastic-container-service";
import IconEks from "@aws-icons/react/architecture-service/amazon-elastic-kubernetes-service";
import IconEcr from "@aws-icons/react/architecture-service/amazon-elastic-container-registry";
import IconElb from "@aws-icons/react/architecture-service/elastic-load-balancing";
import IconIam from "@aws-icons/react/architecture-service/aws-identity-and-access-management";
import IconEbs from "@aws-icons/react/architecture-service/amazon-elastic-block-store";
import IconRedshift from "@aws-icons/react/architecture-service/amazon-redshift";
import IconEni from "@aws-icons/react/resource/amazon-vpc-elastic-network-interface";
import IconFlowLogs from "@aws-icons/react/resource/amazon-vpc-flow-logs";
import IconIgw from "@aws-icons/react/resource/amazon-vpc-internet-gateway";
import IconNacl from "@aws-icons/react/resource/amazon-vpc-network-access-control-list";
import IconEip from "@aws-icons/react/resource/amazon-ec2-elastic-ip-address";
import IconAmi from "@aws-icons/react/resource/amazon-ec2-ami";
import IconPeering from "@aws-icons/react/resource/amazon-vpc-peering-connection";
import IconRouteTable from "@aws-icons/react/resource/amazon-route-53-route-table";
import IconVpc from "@aws-icons/react/architecture-group/virtual-private-cloud-vpc";
import IconPublicSubnet from "@aws-icons/react/architecture-group/public-subnet";
import IconPrivateSubnet from "@aws-icons/react/architecture-group/private-subnet";
import IconAsg from "@aws-icons/react/architecture-group/auto-scaling-group";

// Node label -> icon. Labels with no published AWS icon (e.g. security groups,
// RDS subnet groups) fall back to the initial-letter chip in AwsNode.
const AWS_ICON = {
  EC2: IconEc2,
  S3BUCKET: IconS3,
  RDS: IconRds,
  LAMBDA: IconLambda,
  DYNAMODBTABLE: IconDynamo,
  ELASTICACHE: IconElastiCache,
  ECSCLUSTER: IconEcs,
  EKSCLUSTER: IconEks,
  ECRREPOSITORY: IconEcr,
  LB: IconElb,
  TARGETGROUP: IconElb,
  IAMROLE: IconIam,
  IAMPOLICY: IconIam,
  IAMPROFILE: IconIam,
  VOLUME: IconEbs,
  REDSHIFT: IconRedshift,
  ENI: IconEni,
  FLOWLOG: IconFlowLogs,
  IGW: IconIgw,
  NACL: IconNacl,
  EIP: IconEip,
  AMI: IconAmi,
  VPCPEERING: IconPeering,
  ROUTETABLE: IconRouteTable,
  VPC: IconVpc,
  ASG: IconAsg,
};

// A subnet's icon depends on whether it is public, which the graph payload tells
// us via properties.map_public_ip.
function iconFor(label, properties) {
  if (label === "SUBNET") return properties?.map_public_ip ? IconPublicSubnet : IconPrivateSubnet;
  return AWS_ICON[label] ?? null;
}

const h = React.createElement;

const cx = (...xs) => xs.filter(Boolean).join(" ");

/* ---------- markdown rendering (assistant replies) ---------- */
const MD_OPTS = { gfm: true, breaks: true };

function renderMarkdown(text) {
  if (!text) return "";
  try {
    const out = marked.parse ? marked.parse(text, MD_OPTS) : marked(text);
    return DOMPurify.sanitize(String(out ?? ""));
  } catch {
    return String(text);
  }
}

function Md({ text, className }) {
  return h("div", {
    className: cx("md-body", className),
    dangerouslySetInnerHTML: { __html: renderMarkdown(text) },
  });
}

/* ---------- design tokens (Tailwind literal classes) ---------- */
const SEV = {
  critical: { badge: "sevbadge-critical", dot: "sevdot-critical", hex: "#f87171" },
  high:     { badge: "sevbadge-high",     dot: "sevdot-high",     hex: "#fb923c" },
  medium:   { badge: "sevbadge-medium",   dot: "sevdot-medium",   hex: "#fcd34d" },
  low:      { badge: "sevbadge-low",      dot: "sevdot-low",      hex: "#6ee7b7" },
  info:     { badge: "sevbadge-info",     dot: "sevdot-info",     hex: "#7dd3fc" },
};
const SEV_W = { critical: 15, high: 7, medium: 3, low: 1, info: 0 };
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const JOB = {
  queued:      { dot: "bg-slate-400",              txt: "text-slate-300" },
  running:     { dot: "bg-sky-400",                txt: "text-sky-300 animate-pulse" },
  cancelling:  { dot: "bg-amber-300",              txt: "text-amber-200" },
  cancelled:   { dot: "bg-slate-500",              txt: "text-slate-400" },
  completed:   { dot: "bg-emerald-400",            txt: "text-emerald-300" },
  failed:      { dot: "bg-red-400",                txt: "text-red-300" },
  interrupted: { dot: "bg-amber-300",              txt: "text-amber-200" },
};
const RESUMEABLE = ["interrupted", "cancelled", "failed"];

function posture(findings) {
  const c = findings?.bySeverity ?? {};
  const pen = SEV_ORDER.slice(0, 4).reduce((a, s) => a + (c[s] ?? 0) * SEV_W[s], 0);
  const score = Math.max(0, 100 - Math.round(2.2 * Math.sqrt(pen)));
  const grade = score >= 93 ? "A" : score >= 80 ? "B" : score >= 63 ? "C" : score >= 45 ? "D" : "F";
  return { score, grade, pen };
}
const ringColor = (s) => (s >= 80 ? "#34d399" : s >= 63 ? "#22d3ee" : s >= 45 ? "#fb923c" : "#f87171");

/* ---------- tiny icon set ---------- */
const ICONS = {
  dashboard: { rects: [[3, 3, 7, 9], [14, 3, 7, 6], [3, 16, 7, 5], [14, 13, 7, 8]] },
  graph: { circles: [[6, 5, 2], [6, 19, 2], [18, 12, 2]], lines: [[8, 6, 16, 11], [8, 18, 16, 13]] },
  alert: { paths: ["M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6l7-3z", "M12 8.5v3.5", "M12 15h.01"] },
  scan: { paths: ["M10 2H6a4 4 0 0 0-4 4v4", "M14 2h4a4 4 0 0 1 4 4v4", "M10 22H6a4 4 0 0 1-4-4v-4", "M14 22h4a4 4 0 0 0 4-4v-4"], lines: [[12, 9, 12, 11], [12, 13, 12, 15], [9, 12, 11, 12], [13, 12, 15, 12]] },
  message: { paths: ["M4 5h16v12H8l-4 4V5z"] },
  drift: { paths: ["M17 13l3 3-3 3", "M7 11L4 8l3-3"], lines: [[20, 16, 8, 16], [4, 8, 16, 8]] },
  search: { paths: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"] },
  download: { paths: ["M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3", "M7 10l5 5 5-5", "M12 15V3"] },
  refresh: { paths: ["M21 4v5h-5", "M20.5 9A9 9 0 1 0 22 14", "M3 20v-5h5", "M3.5 15A9 9 0 1 0 2 10"] },
  swap: { paths: ["M7 7h13", "M7 3l4 4-4 4", "M17 17H4", "M17 13l4 4-4 4"] },
  key: { paths: ["M5 11h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8z", "M7 11V7a5 5 0 0 1 10 0v4"] },
  chevron: { paths: ["M6 9l6 6 6-6"] },
  arrowRight: { paths: ["M5 12h14", "M13 6l6 6-6 6"] },
  x: { paths: ["M18 6L6 18", "M6 6l12 12"] },
  external: { paths: ["M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5", "M15 3h6v6", "M10 14L21 3"] },
  play: { paths: ["M7 4l12 8-12 8z"], fill: true },
  stop: { rects: [[6, 4, 12, 14]], fill: true },
  box: { paths: ["M21 8l-9-5-9 5v8l9 5 9-5V8z", "M3 8l9 5 9-5", "M12 13v8"] },
  zap: { paths: ["M13 2L3 14h7l-1 8 11-12h-7l1-8z"], fill: true },
};

function Icon({ name, className }) {
  const def = ICONS[name];
  if (!def) return null;
  return h("svg", {
    className: cx("h-4 w-4", className),
    viewBox: "0 0 24 24",
    fill: def.fill ? "currentColor" : "none",
    stroke: def.fill ? "none" : "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
    (def.paths ?? []).map((d, i) => h("path", { key: "p" + i, d })),
    (def.circles ?? []).map((c, i) => h("circle", { key: "c" + i, cx: c[0], cy: c[1], r: c[2] })),
    (def.lines ?? []).map((l, i) => h("line", { key: "l" + i, x1: l[0], y1: l[1], x2: l[2], y2: l[3] })),
    (def.rects ?? []).map((r, i) => h("rect", { key: "r" + i, x: r[0], y: r[1], width: r[2], height: r[3], rx: 1.5 })),
  );
}

/* ---------- misc helpers ---------- */
function timeAgo(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  const m = Math.round(d / 60e3);
  if (m < 60) return m + "m ago";
  const hh = Math.round(m / 60);
  if (hh < 24) return hh + "h ago";
  return Math.round(hh / 24) + "d ago";
}
function fmtDT(iso) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (isNaN(t)) return iso;
  return t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function shortKey(k) { return (k ?? "").split("/").pop(); }
function pstr(v) {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/* ============================================================ */
/*  GRAPH                                                         */
/* ============================================================ */
const COLORS = {
  VPC: "#6366f1", Subnet: "#f59e0b", EC2: "#ef4444", SG: "#14b8a6", S3BUCKET: "#3b82f6",
  IAMROLE: "#eab308", ENI: "#84cc16", IGW: "#6b7280", EIP: "#1e3a5f", ROUTETABLE: "#6b7280",
  NACL: "#6b7280", RDS: "#b91c1c", REDSHIFT: "#881337", ELASTICACHE: "#9d174d",
  LB: "#ec4899", TARGETGROUP: "#db2777", ASG: "#8b5cf6", DYNAMODBTABLE: "#2563eb",
  IAMPROFILE: "#a16207", IAMPOLICY: "#ca8a04", AMI: "#64748b", OPENSEARCH: "#0ea5e9",
  ECSCLUSTER: "#059669", EKSCLUSTER: "#0284c7", ECRREPO: "#4f46e5", FLOWLOG: "#71717a",
};
const FIND_COLORS = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#64748b" };

/* ---------- custom React Flow node with an AWS icon ----------
 * React Flow's built-in "default" node only renders a text label, so an icon
 * needs a custom node type. Custom nodes must declare their own Handles or
 * edges have nowhere to attach.
 */
const AwsNode = React.memo(function AwsNode({ data }) {
  const Icon = data.icon;
  return h("div", {
    className: "flex items-center gap-2.5 rounded-lg border px-3 py-2 shadow-lg",
    style: {
      background: "#0d1320",
      borderColor: data.accentColor ?? "#475569",
      borderWidth: data.emphasised ? 2 : 1,
      minWidth: 188,
    },
    title: data.title,
  },
    h(Handle, { type: "target", position: Position.Left, style: { opacity: 0, width: 1, height: 1 } }),
    Icon
      ? h(Icon, { width: 30, height: 30, style: { flexShrink: 0 } })
      : h("div", {
          className: "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded font-mono text-[13px] font-bold",
          style: { background: data.accentColor ?? "#334155", color: "#0b1220" },
        }, (data.label ?? "?").slice(0, 2)),
    h("div", { className: "min-w-0 leading-tight" },
      h("div", { className: "truncate font-mono text-[11.5px] font-medium text-slate-100", style: { maxWidth: 150 } },
        (data.marker ?? "") + (data.name ?? "")),
      h("div", { className: "font-mono text-[9.5px] uppercase tracking-wide text-slate-500" }, data.label),
    ),
    h(Handle, { type: "source", position: Position.Right, style: { opacity: 0, width: 1, height: 1 } }),
  );
});

/* ---------- architecture view: nested container nodes ----------
 * React Flow renders containment through parentId + relative child positions,
 * which is what an AWS architecture diagram is: a VPC rectangle holding subnet
 * rectangles holding resources.
 */
function GroupBox({ data }) {
  return h("div", {
    className: "h-full w-full rounded-xl",
    style: {
      background: data.fill,
      border: `${data.borderWidth ?? 1.5}px ${data.borderStyle ?? "solid"} ${data.stroke}`,
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02)",
    },
  },
    // Handles so an edge pointing at a container (e.g. FLOWS_ON -> VPC) still
    // has somewhere to attach.
    h(Handle, { type: "target", position: Position.Left, style: { opacity: 0, width: 1, height: 1 } }),
    h("div", { className: "flex items-center gap-2 px-3 pt-2" },
      data.icon ? h(data.icon, { width: 18, height: 18, style: { flexShrink: 0 } }) : null,
      h("div", { className: "min-w-0" },
        h("div", { className: "truncate font-mono text-[11px] font-semibold", style: { color: data.stroke } },
          data.title),
        data.subtitle
          ? h("div", { className: "truncate font-mono text-[9.5px] text-slate-500" }, data.subtitle)
          : null,
      ),
    ),
    h(Handle, { type: "source", position: Position.Right, style: { opacity: 0, width: 1, height: 1 } }),
  );
}

const NODE_TYPES = { aws: AwsNode, group: GroupBox };

/* layout geometry */
const A_NODE_W = 172, A_NODE_H = 54, A_GAP = 14;
const A_SUB_PADX = 14, A_SUB_HEAD = 36, A_SUB_PADB = 14, A_SUB_COLS = 3;
const A_VPC_PADX = 20, A_VPC_HEAD = 46, A_VPC_PADB = 20, A_VPC_MAXW = 1240;
const A_LANE_COLS = 6;

// Labels that describe topology. IAM (220+ nodes here) and ENIs (one per
// attachment) are not drawn on an architecture diagram — they would bury the
// thing the diagram is for.
const ARCH_EXCLUDE = new Set(["IAMROLE", "IAMPOLICY", "IAMPROFILE", "IAMUSER", "ACCOUNT", "ENI", "AMI"]);
// Regional/global services live outside the VPC boundary.
const ARCH_GLOBAL = new Set(["S3BUCKET", "DYNAMODBTABLE", "ECRREPOSITORY"]);

function gridSize(n, cols, w, h, gap) {
  const c = Math.max(1, Math.min(cols, n));
  const r = Math.max(1, Math.ceil(n / c));
  return { cols: c, rows: r, w: c * w + (c - 1) * gap, h: r * h + (r - 1) * gap };
}

// layoutArchitecture turns the flat graph into nested VPC > subnet > resource
// boxes. Containment comes from vpc_id/subnet_id properties, falling back to
// IN_VPC / IN_SUBNET edges for resources that only express it as an edge
// (Lambda, for instance, carries no subnet_id property).
function layoutArchitecture(graph, opts) {
  const { overlayByKey, region } = opts;
  // Containment is resolved over every node, then filtered for drawing. An
  // Elastic IP reaches its subnet through an ENI, and ENIs are not drawn — so
  // excluding them before resolution would strand the EIP outside the VPC.
  const allNodes = graph.nodes;
  const nodes = allNodes.filter((n) => !ARCH_EXCLUDE.has(n.label));
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const prop = (n, k) => (n.properties ?? {})[k];

  const vpcs = nodes.filter((n) => n.label === "VPC");
  const subnets = nodes.filter((n) => n.label === "SUBNET");

  // Resolve short ids (vpc-abc, subnet-abc) to the ARN keys used as node ids.
  const vpcKeyByShort = new Map(vpcs.map((v) => [v.id.split("/").pop(), v.id]));
  const subKeyByShort = new Map(subnets.map((s) => [s.id.split("/").pop(), s.id]));

  const subnetOf = new Map(), vpcOf = new Map();
  for (const n of allNodes) {
    const s = prop(n, "subnet_id"), v = prop(n, "vpc_id");
    if (s && subKeyByShort.has(s)) subnetOf.set(n.id, subKeyByShort.get(s));
    if (v && vpcKeyByShort.has(v)) vpcOf.set(n.id, vpcKeyByShort.get(v));
  }
  for (const e of graph.edges) {
    if (!byId.has(e.from)) continue;
    if (e.type === "IN_SUBNET" && byId.has(e.to) && !subnetOf.has(e.from)) subnetOf.set(e.from, e.to);
    if ((e.type === "IN_VPC" || e.type === "PART_OF") && byId.has(e.to) && !vpcOf.has(e.from)) vpcOf.set(e.from, e.to);
  }
  // An auto-scaling group names its subnets rather than its VPC.
  for (const n of allNodes) {
    if (vpcOf.has(n.id)) continue;
    const zones = prop(n, "vpc_zone_identifiers");
    const first = (Array.isArray(zones) ? zones : String(zones ?? "").split(","))
      .map((s) => s.trim()).filter(Boolean)[0];
    if (first && subKeyByShort.has(first)) subnetOf.set(n.id, subKeyByShort.get(first));
  }

  // Several resources express containment only through an attachment: an
  // internet gateway is ATTACHED_TO its VPC, a flow log FLOWS_ON one, a volume
  // is ATTACHED_TO an instance, an ElastiCache node ASSOC_WITH a security group.
  // Inherit placement across those rather than special-casing each label —
  // otherwise the internet gateway floats outside the VPC it belongs to.
  const ATTACH = new Set(["ATTACHED_TO", "ASSOC_WITH", "FLOWS_ON", "PART_OF", "CONTAINS", "USES_SUBGRP"]);
  const outgoing = new Map();
  for (const e of graph.edges) {
    if (!ATTACH.has(e.type)) continue;
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e);
  }
  // Two passes so volume -> instance -> subnet -> vpc resolves.
  for (let pass = 0; pass < 3; pass++) {
    for (const n of allNodes) {
      if (subnetOf.has(n.id) && vpcOf.has(n.id)) continue;
      for (const e of outgoing.get(n.id) ?? []) {
        // Only a direct attachment implies sharing the target's subnet; being
        // associated with a security group says nothing about placement.
        if (!subnetOf.has(n.id) && e.type === "ATTACHED_TO" && subnetOf.has(e.to)) {
          subnetOf.set(n.id, subnetOf.get(e.to));
        }
        if (!vpcOf.has(n.id)) {
          if (byId.get(e.to)?.label === "VPC") vpcOf.set(n.id, e.to);
          else if (vpcOf.has(e.to)) vpcOf.set(n.id, vpcOf.get(e.to));
        }
      }
    }
  }

  // A resource in a subnet is in that subnet's VPC.
  for (const [id, sub] of subnetOf) {
    if (!vpcOf.has(id)) {
      const parentVpc = vpcOf.get(sub) ?? (byId.get(sub) && vpcKeyByShort.get(prop(byId.get(sub), "vpc_id")));
      if (parentVpc) vpcOf.set(id, parentVpc);
    }
  }

  const isContainer = (n) => n.label === "VPC" || n.label === "SUBNET";
  const members = nodes.filter((n) => !isContainer(n));

  const inSubnet = new Map(subnets.map((s) => [s.id, []]));
  const inVpcOnly = new Map(vpcs.map((v) => [v.id, []]));
  const global = [];
  for (const m of members) {
    const s = subnetOf.get(m.id), v = vpcOf.get(m.id);
    if (s && inSubnet.has(s) && !ARCH_GLOBAL.has(m.label)) inSubnet.get(s).push(m);
    else if (v && inVpcOnly.has(v) && !ARCH_GLOBAL.has(m.label)) inVpcOnly.get(v).push(m);
    else global.push(m);
  }

  const out = [];
  const leaf = (n, parentId, x, y) => {
    const ov = overlayByKey?.get(n.id);
    out.push({
      id: n.id, type: "aws", parentId, extent: parentId ? "parent" : undefined,
      position: { x, y },
      data: {
        name: n.name || n.id.split("/").pop(), label: n.label,
        marker: ov === "add" ? "+ " : ov === "mod" ? "~ " : "",
        resourceLabel: n.label, icon: iconFor(n.label, n.properties),
        accentColor: ov === "add" ? "#4ade80" : ov === "mod" ? "#fbbf24" : (COLORS[n.label] ?? "#475569"),
        emphasised: Boolean(ov),
        title: `${n.name || ""}\n${n.label}\n${n.id}`,
      },
    });
  };

  // --- size each subnet from its contents, then pack subnets into their VPC ---
  const subSize = new Map();
  for (const s of subnets) {
    const g = gridSize(inSubnet.get(s.id).length, A_SUB_COLS, A_NODE_W, A_NODE_H, A_GAP);
    subSize.set(s.id, { w: g.w + 2 * A_SUB_PADX, h: A_SUB_HEAD + g.h + A_SUB_PADB, g });
  }

  let cursorY = 0;
  const vpcBoxes = [];
  for (const v of vpcs) {
    const mine = subnets
      .filter((s) => (vpcOf.get(s.id) ?? vpcKeyByShort.get(prop(s, "vpc_id"))) === v.id)
      .sort((a, b) => String(prop(a, "az")).localeCompare(String(prop(b, "az"))));

    // pack subnet boxes into rows
    const placed = [];
    let rowX = 0, rowY = 0, rowH = 0, innerW = 0;
    for (const s of mine) {
      const sz = subSize.get(s.id);
      if (rowX > 0 && rowX + sz.w > A_VPC_MAXW) { rowX = 0; rowY += rowH + A_GAP; rowH = 0; }
      placed.push({ s, x: rowX, y: rowY, sz });
      rowX += sz.w + A_GAP;
      rowH = Math.max(rowH, sz.h);
      innerW = Math.max(innerW, rowX - A_GAP);
    }
    let innerH = mine.length ? rowY + rowH : 0;

    // VPC-level resources (no subnet): IGW, route tables, NACLs, SGs, LBs
    const loose = inVpcOnly.get(v.id) ?? [];
    let looseTop = 0;
    if (loose.length) {
      looseTop = innerH ? innerH + A_GAP : 0;
      const g = gridSize(loose.length, Math.max(A_SUB_COLS, Math.floor(A_VPC_MAXW / (A_NODE_W + A_GAP))), A_NODE_W, A_NODE_H, A_GAP);
      innerW = Math.max(innerW, g.w);
      innerH = looseTop + g.h;
    }

    const box = {
      id: v.id,
      w: Math.max(innerW, 320) + 2 * A_VPC_PADX,
      h: A_VPC_HEAD + Math.max(innerH, A_NODE_H) + A_VPC_PADB,
      x: 0, y: cursorY,
    };
    vpcBoxes.push(box);
    cursorY += box.h + 28;

    out.push({
      id: v.id, type: "group", position: { x: box.x, y: box.y },
      style: { width: box.w, height: box.h },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `VPC  ${v.name || v.id.split("/").pop()}`,
        subtitle: [prop(v, "cidr_block"), prop(v, "default_vpc") ? "default VPC" : null].filter(Boolean).join("   ·   "),
        fill: "rgba(99,102,241,0.05)", stroke: "#6366f1", icon: IconVpc,
      },
    });

    for (const p of placed) {
      const isPublic = prop(p.s, "map_public_ip");
      out.push({
        id: p.s.id, type: "group", parentId: v.id, extent: "parent",
        position: { x: A_VPC_PADX + p.x, y: A_VPC_HEAD + p.y },
        style: { width: p.sz.w, height: p.sz.h },
        selectable: false, draggable: false, zIndex: 1,
        data: {
          title: p.s.name || p.s.id.split("/").pop(),
          subtitle: [isPublic ? "public" : "private", prop(p.s, "az"), prop(p.s, "cidr_block")].filter(Boolean).join("   ·   "),
          fill: isPublic ? "rgba(34,197,94,0.06)" : "rgba(56,189,248,0.05)",
          stroke: isPublic ? "#22c55e" : "#38bdf8",
          borderStyle: isPublic ? "solid" : "dashed",
          icon: isPublic ? IconPublicSubnet : IconPrivateSubnet,
        },
      });
      inSubnet.get(p.s.id).forEach((m, i) => {
        const col = i % p.sz.g.cols, row = Math.floor(i / p.sz.g.cols);
        leaf(m, p.s.id, A_SUB_PADX + col * (A_NODE_W + A_GAP), A_SUB_HEAD + row * (A_NODE_H + A_GAP));
      });
    }

    const looseCols = Math.max(A_SUB_COLS, Math.floor(A_VPC_MAXW / (A_NODE_W + A_GAP)));
    loose.forEach((m, i) => {
      const col = i % looseCols, row = Math.floor(i / looseCols);
      leaf(m, v.id, A_VPC_PADX + col * (A_NODE_W + A_GAP), A_VPC_HEAD + looseTop + row * (A_NODE_H + A_GAP));
    });
  }

  // --- regional / global services, outside any VPC ---
  if (global.length) {
    const g = gridSize(global.length, A_LANE_COLS, A_NODE_W, A_NODE_H, A_GAP);
    const box = { w: g.w + 2 * A_VPC_PADX, h: A_VPC_HEAD + g.h + A_VPC_PADB, x: 0, y: cursorY };
    out.push({
      id: "__region_lane__", type: "group", position: { x: box.x, y: box.y },
      style: { width: box.w, height: box.h },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `Regional & global services`,
        subtitle: region ? `${region}   ·   outside the VPC boundary` : "outside the VPC boundary",
        fill: "rgba(148,163,184,0.04)", stroke: "#64748b", borderStyle: "dashed",
      },
    });
    global.forEach((m, i) => {
      const col = i % g.cols, row = Math.floor(i / g.cols);
      leaf(m, "__region_lane__", A_VPC_PADX + col * (A_NODE_W + A_GAP), A_VPC_HEAD + row * (A_NODE_H + A_GAP));
    });
  }

  return out;
}

// Containment is drawn as nesting in the architecture view, so those edges would
// just be noise on top of it.
const ARCH_HIDDEN_EDGES = new Set(["IN_VPC", "IN_SUBNET", "PART_OF", "CONTAINS"]);

function layoutGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 240 });
  nodes.forEach((n) => g.setNode(n.id, { width: 210, height: 56 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id) || { x: 0, y: 0 };
    return { ...n, position: { x: p.x, y: p.y } };
  });
}

function Diagram({ graph, findingsGraph, diffOverlay, view, region }) {
  if (!graph) {
    return h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }
  const overlayByKey = useMemo(() => {
    const m = new Map();
    for (const n of diffOverlay?.nodes ?? []) m.set(n.key, n.kind);
    return m;
  }, [diffOverlay]);
  const findNodes = useMemo(() => (findingsGraph?.nodes ?? []).map((n) => ({
    id: n.id, type: "default",
    data: { label: `${n.name}\n[finding]`, resourceLabel: "Finding" },
    style: { background: FIND_COLORS[n.tags?.severity] ?? "#475569", color: "#fff", border: "1px dashed #fff", borderRadius: 4, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-line" },
  })), [findingsGraph]);
  const findEdges = useMemo(() => (findingsGraph?.edges ?? []).map((e, i) => ({
    id: `affect-${i}`, source: e.from, target: e.to, type: "default", animated: true,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#fb7185", width: 14, height: 14 },
    style: { stroke: "#fb7185", strokeDasharray: "4 3" }, labelStyle: { fontSize: 0 },
  })), [findingsGraph]);
  const nodeIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const dagreNodes = useMemo(() =>
    graph.nodes.map((n) => {
      const ov = overlayByKey.get(n.id);
      const name = n.name || n.id.split("/").pop();
      const marker = ov === "add" ? "+ " : ov === "mod" ? "~ " : "";
      return {
        id: n.id, type: "aws",
        data: {
          name,
          label: n.label,
          marker,
          resourceLabel: n.label,
          icon: iconFor(n.label, n.properties),
          // drift overlay keeps its green/amber emphasis
          accentColor: ov === "add" ? "#4ade80" : ov === "mod" ? "#fbbf24" : (COLORS[n.label] ?? "#475569"),
          emphasised: Boolean(ov),
          title: `${name}\n${n.label}\n${n.id}`,
        },
      };
    }),
  [graph, overlayByKey]);
  const dagreEdges = useMemo(() =>
    graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => ({
      id: `${e.from}→${e.to}→${e.type}`, source: e.from, target: e.to, type: "default",
      animated: e.type === "REFERENCES" || e.type === "FLOWS_ON",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 16, height: 16 },
      style: e.type === "REFERENCES" ? { stroke: "#f97316", strokeDasharray: "5 5" } : { stroke: "#475569" },
      labelStyle: { fontSize: 0 },
    })),
  [graph, nodeIds]);
  const allNodes = useMemo(() => [...dagreNodes, ...findNodes], [dagreNodes, findNodes]);
  const allEdges = useMemo(() => [...dagreEdges, ...findEdges], [dagreEdges, findEdges]);
  const layoutedNodes = useMemo(() => layoutGraph(allNodes, allEdges), [allNodes, allEdges]);

  const archNodes = useMemo(
    () => (view === "arch" ? layoutArchitecture(graph, { overlayByKey, region }) : []),
    [view, graph, overlayByKey, region],
  );
  const archEdges = useMemo(() => {
    if (view !== "arch") return [];
    const drawn = new Set(archNodes.map((n) => n.id));
    return graph.edges
      .filter((e) => !ARCH_HIDDEN_EDGES.has(e.type) && drawn.has(e.from) && drawn.has(e.to))
      .map((e) => ({
        id: `${e.from}→${e.to}→${e.type}`, source: e.from, target: e.to, type: "default",
        animated: e.type === "REFERENCES",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 13, height: 13 },
        style: e.type === "REFERENCES"
          ? { stroke: "#f97316", strokeDasharray: "5 5", strokeWidth: 1.2 }
          : { stroke: "#475569", strokeWidth: 1.2 },
        labelStyle: { fontSize: 0 }, zIndex: 5,
      }));
  }, [view, graph, archNodes]);

  const isArch = view === "arch";
  return h(ReactFlowProvider, null,
    h(FlowCanvas, {
      nodes: isArch ? archNodes : layoutedNodes,
      edges: isArch ? archEdges : allEdges,
      overlayByKey, COLORS, viewKey: view,
    }),
  );
}

function FlowCanvas({ nodes, edges, overlayByKey, COLORS, viewKey }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodes.length) return;
    let stopped = false, tries = 0;
    const attempt = () => {
      if (stopped) return;
      tries++;
      fitView({ padding: 0.12, maxZoom: 1.2 }).then((done) => {
        if (!done && tries < 20) setTimeout(attempt, 150);
      });
    };
    const id = requestAnimationFrame(attempt);
    return () => { stopped = true; cancelAnimationFrame(id); };
  }, [nodes.length, edges.length, viewKey]);
  return h("div", { className: "h-full w-full" },
    h(ReactFlow, {
      nodes, edges, nodesDraggable: false,
      edgesUpdatable: false, nodeTypes: NODE_TYPES, defaultEdgeOptions: { type: "default" },
    },
      h(Background, { color: "#16213a" }),
      h(Controls, { style: { background: "#0d1320", color: "#9ca3af", borderColor: "#2a3550" } }),
      h(MiniMap, {
        nodeColor: (n) => {
          const ov = overlayByKey.get(n.id);
          if (ov === "add") return "#4ade80";
          if (ov === "mod") return "#fbbf24";
          return n.data?.resourceLabel === "Finding" ? "#f97316" : COLORS[n.data?.resourceLabel] ?? "#475569";
        },
        maskColor: "rgba(255,255,255,0.05)",
        style: { background: "#0a0f1c", border: "1px solid #1e2a45" },
      })
    )
  );
}

/* ============================================================ */
/*  SUMMARY  (security posture)                                   */
/* ============================================================ */
function Ring({ score }) {
  const R = 44, C = 2 * Math.PI * R;
  const col = ringColor(score);
  const pct = score / 100;
  return h("div", { className: "relative h-28 w-28 shrink-0" },
    h("svg", { viewBox: "0 0 100 100", className: "h-full w-full -rotate-90" },
      h("circle", { cx: 50, cy: 50, r: R, fill: "none", stroke: "rgba(148,163,184,0.14)", strokeWidth: 10 }),
      h("circle", {
        cx: 50, cy: 50, r: R, fill: "none", stroke: col, strokeWidth: 10, strokeLinecap: "round",
        strokeDasharray: `${C * pct} ${C}`,
        style: { transition: "stroke-dasharray 0.6s ease, stroke 0.3s ease" },
      }),
    ),
    h("div", { className: "absolute inset-0 flex flex-col items-center justify-center" },
      h("div", { className: "font-mono text-3xl font-bold", style: { color: col } }, score),
      h("div", { className: "text-[10px] font-semibold uppercase tracking-widest text-slate-500" }, "posture"),
    ),
  );
}

function Summary({ summary, findingsData, jobs, go }) {
  if (!summary) {
    return h("div", { className: "flex h-full items-center justify-center" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }
  const latest = summary.latest_snapshot;
  const fcounts = summary.findings?.bySeverity ?? {};
  const ftotal = Object.values(fcounts).reduce((a, b) => a + b, 0) || summary.findings?.total || 0;
  const p = posture(summary.findings);
  const list = findingsData?.findings ?? [];
  const labels = summary.labels ?? {};
  const mix = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  const topMix = mix.slice(0, 7);
  const mixTotal = mix.reduce((a, [, v]) => a + v, 0);
  const topFindings = [...list].sort((a, b) =>
    (SEV_ORDER.indexOf(a.severity) || 9) - (SEV_ORDER.indexOf(b.severity) || 9) || a.rule.localeCompare(b.rule)
  ).slice(0, 5);
  const recent = (jobs ?? []).filter((j) => j.status === "completed").slice(0, 4);

  if (!latest) {
    return h("div", { className: "flex h-full items-center justify-center p-8" },
      h("div", { className: "card max-w-lg p-8 text-center fade-in" },
        h("div", { className: "mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-300" }, h(Icon, { name: "scan", className: "h-7 w-7" })),
        h("h2", { className: "text-lg font-semibold text-slate-100" }, "No data yet"),
        h("p", { className: "mt-2 text-sm text-slate-400" }, "AWSome has not scanned an account yet. Run your first scan to map resources into Neo4j, surface findings, and track drift."),
        h("div", { className: "mt-6 flex items-center justify-center gap-3" },
          h("button", { className: "btn-primary", onClick: () => go("scans") }, h(Icon, { name: "play" }), "Open scans"),
        ),
      ),
    );
  }

  const maxSev = fcounts.critical ? "critical" : fcounts.high ? "high" : fcounts.medium ? "medium" : fcounts.low ? "low" : "info";
  const sevRows = SEV_ORDER.filter((s) => fcounts[s] > 0);

  return h("div", { className: "mx-auto max-w-6xl min-h-0 flex-1 overflow-y-auto px-6 py-6 fade-in" },
    h("div", { className: "grid gap-4 lg:grid-cols-[340px_1fr]" },
      /* posture hero */
      h("div", { className: "card flex items-center gap-5 p-5" },
        h(Ring, { score: p.score }),
        h("div", { className: "min-w-0" },
          h("div", { className: "flex items-center gap-2" },
            h("span", { className: "font-mono text-2xl font-bold", style: { color: ringColor(p.score) } }, p.grade),
            h("span", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-500" }, "grade"),
          ),
          h("div", { className: "mt-2 text-[13px] leading-relaxed text-slate-400" },
            ftotal === 0
              ? "Account currently shows no findings."
              : `${ftotal} open finding${ftotal === 1 ? "" : "s"} · weighted exposure ${p.pen}.`,
          ),
          h("div", { className: "mt-3 flex flex-wrap items-center gap-2" },
            h("span", { className: "chip" }, h(Icon, { name: "box", className: "h-3.5 w-3.5 text-slate-400" }), summary.nodes ?? "-", " resources"),
            h("span", { className: "chip" }, h(Icon, { name: "graph", className: "h-3.5 w-3.5 text-slate-400" }), summary.edges ?? "-", " edges"),
            h("span", { className: "chip" }, h(Icon, { name: "dashboard", className: "h-3.5 w-3.5 text-slate-400" }), (summary.regions ?? []).length, " regions"),
          ),
        ),
      ),
      /* severity distribution */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Findings by severity"),
          h("button", { className: "btn-ghost", onClick: () => go("findings") }, "view all", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        ftotal > 0
          ? h(Fragment, null,
              h("div", { className: "flex h-2.5 w-full overflow-hidden rounded-full bg-white/10" },
                sevRows.map((s) => h("div", {
                  key: s,
                  className: cx("h-full", { critical: "bg-red-400", high: "bg-orange-400", medium: "bg-amber-300", low: "bg-emerald-300", info: "bg-sky-300" }[s]),
                  style: { width: `${((fcounts[s] / ftotal) * 100).toFixed(1)}%` },
                })),
              ),
              h("div", { className: "mt-3 grid gap-1.5" },
                sevRows.map((s) => {
                  const sev = SEV[s];
                  return h("button", {
                    key: s, onClick: () => go("findings", { sev: s }),
                    className: "flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-white/5",
                  },
                    h("span", { className: cx("sevdot", sev.dot) }),
                    h("span", { className: "flex-1 text-[12.5px] capitalize text-slate-400" }, s),
                    h("span", { className: "font-mono text-[13px] font-semibold text-slate-200" }, fcounts[s]),
                    h(Icon, { name: "chevron", className: "h-3.5 w-3.5 -rotate-90 text-slate-600" }),
                  );
                }),
              ),
            )
          : h("div", { className: "flex h-40 items-center justify-center text-sm text-slate-500" },
              "No findings on the latest snapshot."),
      ),
    ),

    h("div", { className: "mt-4 grid gap-4 lg:grid-cols-2" },
      /* resource mix */
      h("div", { className: "card p-5" },
        h("span", { className: "section-title" }, "Resource mix"),
        h("div", { className: "mt-3 space-y-2" },
          topMix.map(([label, count]) => h("div", { key: label, className: "flex items-center gap-3" },
            h("div", { className: "w-24 shrink-0 truncate font-mono text-[11.5px] text-slate-400" }, label),
            h("div", { className: "h-2 flex-1 overflow-hidden rounded-full bg-white/10" },
              h("div", { className: "h-full rounded-full", style: { width: `${((count / mixTotal) * 100).toFixed(0)}%`, background: COLORS[label] ?? "#64748b" } })),
            h("span", { className: "w-8 shrink-0 text-right font-mono text-[12px] text-slate-300" }, count),
          )),
          mix.length > topMix.length
            ? h("div", { className: "pt-1 text-[11.5px] text-slate-500" }, `+ ${mix.length - topMix.length} more labels (${mixTotal} total)`)
            : null,
        ),
      ),
      /* snapshot + account context */
      h("div", { className: "card p-5" },
        h("span", { className: "section-title" }, "Snapshot"),
        h("div", {
          className: "mt-3 grid gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-3",
        },
          metaRow("snapshot", latest.id),
          metaRow("account", (summary.accounts ?? []).join(", ") || "—"),
          metaRow("regions", (summary.regions ?? []).join(", ") || "—"),
          metaRow("scanned", latest.summary?.finished_at ? fmtDT(latest.summary.finished_at) : "—"),
          metaRow("status", latest.summary?.status ?? "—"),
        ),
        h("div", { className: "mt-3 text-[11.5px] leading-relaxed text-slate-500" },
          "Posture is computed from the latest snapshot's findings. Re-run a scan after changes to refresh."),
      ),
    ),

    h("div", { className: "mt-4 grid gap-4 lg:grid-cols-2" },
      /* top risks */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Highest risk findings"),
          h("button", { className: "btn-ghost", onClick: () => go("findings") }, "all findings", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        topFindings.length
          ? h("div", { className: "space-y-1.5" },
              topFindings.map((f) =>
                h("button", {
                  key: f.id,
                  onClick: () => go("findings", { sev: f.severity }),
                  className: "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5",
                },
                  h("span", { className: cx("sevdot", (SEV[f.severity] ?? SEV.info).dot) }),
                  h("span", { className: "min-w-0 flex-1" },
                    h("span", { className: "block truncate text-[13px] text-slate-200" }, f.message),
                    h("span", { className: "mt-0.5 flex items-center gap-2 text-[11px] text-slate-500" },
                      h("span", { className: "font-mono" }, f.rule),
                      h("span", { className: "truncate" }, f.resource_name || shortKey(f.resource_key)),
                    ),
                  ),
                  h(Icon, { name: "chevron", className: "h-3.5 w-3.5 -rotate-90 text-slate-600" }),
                )
              ),
            )
          : h("div", { className: "flex h-24 items-center justify-center text-sm text-emerald-300/80" },
              "No findings — great shape."),
      ),
      /* recent scans */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Recent scans"),
          h("button", { className: "btn-ghost", onClick: () => go("scans") }, "all scans", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        recent.length
          ? h("div", { className: "space-y-1.5" },
              recent.map((j) =>
                h("button", {
                  key: j.id, onClick: () => go("scans"),
                  className: "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5",
                },
                  h("span", { className: cx("h-2 w-2 shrink-0 rounded-full", (JOB[j.status] ?? JOB.completed).dot) }),
                  h("span", { className: "min-w-0 flex-1 font-mono text-[12px] text-slate-300" }, shortKey(j.snapshot_id || j.id)),
                  h("span", { className: "text-[11px] text-slate-500" }, `${j.nodes ?? 0} nodes · ${j.edges ?? 0} edges`),
                  h("span", { className: "text-[11px] text-slate-500" }, timeAgo(j.finished_at || j.created_at)),
                )
              ),
            )
          : h("div", { className: "flex h-24 items-center justify-center text-sm text-slate-500" }, "No completed scans yet."),
      ),
    ),
  );
}

function metaRow(k, v) {
  return h("div", { key: k, className: "flex items-baseline justify-between gap-4" },
    h("span", { className: "kpi-label" }, k),
    h("span", { className: "min-w-0 truncate font-mono text-[12.5px] text-slate-300" }, v),
  );
}

/* ============================================================ */
/*  FINDINGS                                                      */
/* ============================================================ */
function Findings({ data, sev, setSev, onAsk }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [sort, setSort] = useState("sev");
  const [openId, setOpenId] = useState(null);

  const counts = data?.counts?.bySeverity ?? {};
  const categories = useMemo(() => {
    const s = new Set((data?.findings ?? []).map((f) => f.category).filter(Boolean));
    return ["all", ...s];
  }, [data]);

  const visible = useMemo(() => {
    let f = data?.findings ?? [];
    if (sev) f = f.filter((x) => x.severity === sev);
    if (cat !== "all") f = f.filter((x) => x.category === cat);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      f = f.filter((x) =>
        (x.rule ?? "").toLowerCase().includes(t) ||
        (x.message ?? "").toLowerCase().includes(t) ||
        (x.resource_name ?? "").toLowerCase().includes(t) ||
        (x.resource_key ?? "").toLowerCase().includes(t)
      );
    }
    const idx = (s) => SEV_ORDER.indexOf(s) ?? 9;
    if (sort === "sev") f = [...f].sort((a, b) => idx(a.severity) - idx(b.severity) || a.rule.localeCompare(b.rule));
    if (sort === "rule") f = [...f].sort((a, b) => a.rule.localeCompare(b.rule));
    if (sort === "resource") f = [...f].sort((a, b) => (a.resource_name ?? "").localeCompare(b.resource_name ?? ""));
    return f;
  }, [data, sev, cat, q, sort]);

  if (!data) {
    return h("div", { className: "flex h-full items-center justify-center" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }

  const sevChips = SEV_ORDER.filter((s) => counts[s] > 0);

  const exportUrl = (fmt) => {
    const p = new URLSearchParams({ format: fmt });
    if (sev) p.set("severity", sev);
    if (cat !== "all") p.set("category", cat);
    if (q.trim()) p.set("q", q.trim());
    if (data?.snapshot) p.set("snapshot", data.snapshot);
    return `/api/findings/export?${p}`;
  };

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "shrink-0 border-b border-white/10 px-6 py-3" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("div", { className: "relative min-w-[220px] flex-1" },
          h(Icon, { name: "search", className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" }),
          h("input", {
            className: "input pl-9",
            placeholder: "Search rule, message, resource…",
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
        ),
        h("button", { className: cx("toggle", !sev ? "toggle-on" : "toggle-off"), onClick: () => setSev(null) }, "all"),
        sevChips.map((s) =>
          h("button", { key: s, className: cx("toggle", sev === s ? "toggle-on" : "toggle-off"), onClick: () => setSev(s) },
            s,
            h("span", { className: "font-mono text-[11px]" }, counts[s]),
          )
        ),
        h("select", { className: "select", value: cat, onChange: (e) => setCat(e.target.value), title: "category" },
          categories.map((c) => h("option", { key: c, value: c }, c === "all" ? "all categories" : c)),
        ),
        h("select", { className: "select", value: sort, onChange: (e) => setSort(e.target.value), title: "sort" },
          h("option", { value: "sev" }, "severity"),
          h("option", { value: "rule" }, "rule"),
          h("option", { value: "resource" }, "resource"),
        ),
        // Export mirrors the active filters, so you get exactly the rows on screen.
        h("div", { className: "ml-auto flex items-center gap-1" },
          h("span", { className: "text-[11px] text-slate-500" }, "export"),
          ["csv", "md", "json"].map((fmt) =>
            h("a", {
              key: fmt,
              className: "toggle toggle-off",
              href: exportUrl(fmt),
              download: "",
              title: `Download ${visible.length} finding(s) as ${fmt.toUpperCase()}`,
            }, fmt)
          ),
        ),
      ),
      h("div", { className: "mt-2 text-[11.5px] text-slate-500" },
        h("span", { className: "font-semibold text-slate-300" }, visible.length), " of ", h("span", { className: "font-semibold text-slate-300" }, (data.counts?.total ?? 0) + (data.findings ?? []).length - (data.findings ?? []).length), " shown"
      ),
    ),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-6 py-4" },
      data.findings.length === 0
        ? h("div", { className: "flex h-full flex-col items-center justify-center gap-2 text-center" },
            h("div", { className: "flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-400/10 text-emerald-300" }, h(Icon, { name: "alert", className: "h-6 w-6" })),
            h("div", { className: "text-sm font-medium text-slate-300" }, "No findings on the latest snapshot"),
            h("div", { className: "max-w-sm text-[12.5px] text-slate-500" }, "Run a scan to evaluate resources. New findings will appear here as they surface."),
            h("span", { className: "chip mt-2" }, "score the account, not the tool"),
          )
        : visible.length === 0
          ? h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" }, "Nothing matches the current filters.")
          : h("div", { className: "mx-auto max-w-4xl space-y-2" },
              visible.map((f) => {
                const sevC = SEV[f.severity] ?? SEV.info;
                const opened = openId === f.id;
                return h("div", {
                  key: f.id,
                  onClick: () => setOpenId(opened ? null : f.id),
                  className: cx(
                    "fade-in group cursor-pointer rounded-xl border px-4 py-3 transition",
                    opened ? "border-indigo-400/40 bg-indigo-500/5" : "border-white/10 bg-ink-850/70 hover:border-white/20 hover:bg-ink-800/60",
                  ),
                },
                  h("div", { className: "flex items-start gap-3" },
                    h("div", { className: "pt-1" },
                      h("span", { className: cx("sevdot h-2.5 w-2.5", sevC.dot) }),
                    ),
                    h("div", { className: "min-w-0 flex-1" },
                      h("div", { className: "text-[13.5px] font-medium leading-snug text-slate-100" }, f.message),
                      h("div", { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-500" },
                        h("span", { className: cx("sevbadge", sevC.badge) }, f.severity),
                        h("span", { className: "font-mono text-slate-400" }, f.rule),
                        h("span", { className: "text-slate-400" }, f.resource_name || shortKey(f.resource_key)),
                        f.category ? h("span", { className: "capitalize" }, f.category) : null,
                        f.region ? h("span", null, f.region) : null,
                      ),
                    ),
                    h("div", { className: "flex shrink-0 items-center gap-1" },
                      h("button", {
                        className: cx("btn-ghost", "hidden sm:inline-flex"),
                        title: "Ask the copilot about this finding",
                        onClick: (e) => { e.stopPropagation(); onAsk(f); },
                      }, h(Icon, { name: "message", className: "h-3.5 w-3.5" }), "help"),
                      h(Icon, { name: "chevron", className: cx("h-4 w-4 text-slate-500 transition", opened && "rotate-180") }),
                    ),
                  ),
                  opened
                    ? h("div", { className: "mt-3 grid gap-4 border-t border-white/10 pt-3 sm:grid-cols-2" },
                        h("div", null,
                          h("div", { className: "kpi-label mb-1" }, "Remediation"),
                          h("p", { className: "text-[13px] leading-relaxed text-slate-300" }, f.remediation || "No remediation guidance recorded."),
                        ),
                        h("div", null,
                          h("div", { className: "kpi-label mb-1" }, "Context"),
                          h("div", { className: "space-y-1 font-mono text-[11.5px] text-slate-500" },
                            h("div", null, "resource: ", h("span", { className: "break-all text-slate-300" }, shortKey(f.resource_key))),
                            h("div", null, "key: ", h("span", { className: "break-all text-slate-400" }, f.resource_key)),
                            f.account_id ? h("div", null, "account: ", h("span", { className: "text-slate-300" }, f.account_id)) : null,
                            h("div", null, "category: ", h("span", { className: "text-slate-300" }, f.category)),
                          ),
                        ),
                      )
                    : null,
                );
              }),
              visible.length > (data.findings?.length ?? 0)
                ? null
                : h("div", { className: "pb-2 pt-3 text-center text-[11.5px] text-slate-600" }, "— end —"),
            ),
    ),
  );
}

/* ============================================================ */
/*  SCANS                                                         */
/* ============================================================ */
function fmtDur(ms) {
  if (!ms || isNaN(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Scans({ jobs, connected, run, act, scannedRegions }) {
  // Default to the regions the latest snapshot actually covered. Hardcoding
  // "us-east-1" produces a broken scan in any non-commercial partition
  // (GovCloud, China), where that region does not exist.
  const [regions, setRegions] = useState(scannedRegions || "us-east-1");
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && scannedRegions) setRegions(scannedRegions);
  }, [scannedRegions, pinned]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // /api/jobs can answer with an error object (e.g. the scan daemon is not
  // running), so never assume this is an array — .find() on an object took the
  // whole SPA down.
  const list = Array.isArray(jobs) ? jobs : [];
  const live = list.find((j) => j.status === "queued" || j.status === "running" || j.status === "cancelling");
  const history = list.filter((j) => !["queued", "running", "cancelling"].includes(j.status));

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live?.id, live?.status]);

  const doRun = async () => {
    setBusy(true);
    try {
      await run(regions.split(",").map((s) => s.trim()).filter(Boolean));
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };
  const actRow = async (id, action) => {
    try { await act(id, action); } catch (e) { alert(e.message); }
  };
  const totalSteps = (j) => j.steps?.length ?? 0;
  const doneSteps = (j) => j.steps?.filter((s) => s.status === "completed").length ?? 0;
  const active = live?.steps?.find((s) => s.status === "running");

  return h("div", { className: "mx-auto grid max-w-6xl min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-6 lg:grid-cols-3 fade-in" },
    /* left: active scan */
    h("div", { className: "space-y-4 lg:col-span-2" },
      live && live.status !== "cancelling"
        ? h("div", { className: "card p-5 fade-in" },
            h("div", { className: "flex flex-wrap items-center gap-2" },
              h("span", { className: "relative flex h-2.5 w-2.5" },
                h("span", { className: "absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" }),
                h("span", { className: "relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-400" }),
              ),
              h("span", { className: "text-sm font-semibold text-slate-100" }, live.status === "queued" ? "Scan queued" : "Scan in progress"),
              h("code", { className: "font-mono text-[11px] text-slate-400" }, shortKey(live.snapshot_id || live.id)),
              h("span", { className: "ml-auto font-mono text-[11.5px] text-slate-500" }, `${doneSteps(live)} / ${totalSteps(live)} steps`),
            ),
            live.status === "running"
              ? h(Fragment, null,
                  h("div", { className: "prog mt-4" },
                    h("div", { className: "prog-fill", style: { width: `${totalSteps(live) ? Math.round((doneSteps(live) / totalSteps(live)) * 100) : 4}%` } })),
                  h("div", { className: "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-slate-500" },
                    active ? h("span", null, "current: ", h("span", { className: "font-mono text-sky-300" }, active.service?.replaceAll("-", " ")), " · ", active.region) : h("span", null, "warming up…"),
                    h("span", null, "elapsed ", h("span", { className: "font-mono text-slate-300" }, fmtDur(now - Date.parse(live.started_at || live.created_at)))),
                    h("span", null, h("span", { className: "font-mono text-slate-300" }, live.nodes ?? 0), " nodes"),
                    h("span", null, h("span", { className: "font-mono text-slate-300" }, live.edges ?? 0), " edges"),
                  ),
                  h("div", { className: "mt-3 flex flex-wrap gap-1.5" },
                    (live.steps ?? []).map((s, i) =>
                      h("span", {
                        key: i,
                        title: `${s.service} · ${s.region} · ${s.status}`,
                        className: cx(
                          "rounded-md px-1.5 py-0.5 font-mono text-[10px] tracking-tight",
                          s.status === "completed" ? "bg-emerald-400/15 text-emerald-300" :
                          s.status === "running" ? "bg-sky-400/20 text-sky-200" :
                          s.status === "failed" ? "bg-red-400/15 text-red-300" :
                          "bg-white/5 text-slate-600",
                        ),
                      }, s.service.replaceAll("-", ".")),
                    ),
                  ),
                )
              : h("div", { className: "mt-3 text-[12.5px] text-slate-500" }, "Waiting for a worker slot…"),
            h("div", { className: "mt-4 flex items-center gap-2" },
              live.status === "running" || live.status === "queued"
                ? h("button", { className: "btn-danger", onClick: () => actRow(live.id, "cancel") }, h(Icon, { name: "stop", className: "h-3.5 w-3.5" }), "Cancel scan")
                : null,
            ),
          )
        : h("div", { className: "card flex h-56 flex-col items-center justify-center gap-2 border-dashed p-6 text-center" },
            h("div", { className: "flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-slate-400" }, h(Icon, { name: "scan", className: "h-6 w-6" })),
            h("div", { className: "text-sm font-medium text-slate-300" }, "No active scan"),
            h("div", { className: "max-w-xs text-[12.5px] leading-relaxed text-slate-500" },
              "Trigger a scan to sweep 26 resource services across your selected regions, load the graph into Neo4j, and compute findings."),
          ),
      /* history */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "History"),
          h("span", { className: "text-[11px] text-slate-500" }, (jobs ?? []).length, " jobs"),
        ),
        history.length
          ? h("div", { className: "space-y-1.5" },
              history.map((j) =>
                h("div", { key: j.id, className: "flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition hover:bg-white/[0.04]" },
                  h("span", { className: cx("h-2 w-2 shrink-0 rounded-full", (JOB[j.status] ?? JOB.completed).dot) }),
                  h("div", { className: "min-w-0 flex-1" },
                    h("div", { className: "flex items-center gap-2" },
                      h("code", { className: "font-mono text-[11.5px] text-slate-300" }, shortKey(j.snapshot_id || j.id)),
                      h("span", { className: cx("text-[11px] font-medium capitalize", (JOB[j.status] ?? {}).txt ?? "text-slate-400") }, j.status),
                    ),
                    h("div", { className: "mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500" },
                      h("span", null, `${j.nodes ?? 0} nodes · ${j.edges ?? 0} edges`),
                      (j.regions?.length ? h("span", null, j.regions.join(", ")) : null),
                      h("span", null, fmtDT(j.finished_at || j.created_at)),
                    ),
                  ),
                  RESUMEABLE.includes(j.status)
                    ? h("button", { className: "btn", onClick: () => actRow(j.id, "resume") }, h(Icon, { name: "refresh", className: "h-3.5 w-3.5" }), "resume")
                    : null,
                ),
              ),
            )
          : h("div", { className: "py-6 text-center text-sm text-slate-500" }, "No scan history yet."),
      ),
    ),
    /* right: run control */
    h("div", { className: "space-y-4" },
      h("div", { className: "card space-y-3 p-5" },
        h("span", { className: "section-title" }, "New scan"),
        h("label", { className: "kpi-label" }, "Regions"),
        h("input", {
          className: "input font-mono",
          value: regions,
          onChange: (e) => { setPinned(true); setRegions(e.target.value); },
          placeholder: "us-east-1, eu-west-1, ap-south-1…",
        }),
        h("button", { className: "btn-primary w-full justify-center", disabled: busy, onClick: doRun },
          h(Icon, { name: busy ? "refresh" : "play", className: busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5" }),
          busy ? "Starting…" : "Scan now"),
        h("div", { className: "flex items-center gap-2 text-[11.5px] text-slate-400" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-slate-500") }),
          connected ? "scanner daemon live" : "scanner daemon offline",
        ),
        h("p", { className: "text-[11.5px] leading-relaxed text-slate-500" },
          "Streams results to Neo4j and stores a snapshot bundle under snapshots/. Jobs run in the background."),
      ),
    ),
  );
}

/* ============================================================ */
/*  COPILOT (Ask)                                                 */
/* ============================================================ */
const SUGGESTIONS = [
  "What is my overall security posture?",
  "Are any resources publicly exposed?",
  "Which resources are missing encryption?",
  "Is VPC flow logging enabled everywhere?",
  "What should I fix first?",
];

const PMETA = {
  heuristic: { label: "Heuristic", badge: "border-slate-400/30 bg-slate-400/10 text-slate-300" },
  bedrock:   { label: "Bedrock",   badge: "border-orange-400/30 bg-orange-400/10 text-orange-300" },
  openrouter:{ label: "OpenRouter", badge: "border-sky-400/30 bg-sky-400/10 text-sky-300" },
  opencode:  { label: "opencode",  badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
};

const SKILL_META = {
  drift:    { label: "Drift",      icon: "drift", cls: "from-sky-500/20 to-cyan-950/40 text-cyan-300 ring-cyan-400/30", glow: "shadow-[0_0_14px_rgba(34,211,238,0.15)]" },
  findings: { label: "Findings",   icon: "alert", cls: "from-rose-500/20 to-rose-950/40 text-rose-300 ring-rose-400/30", glow: "shadow-[0_0_14px_rgba(251,113,133,0.15)]" },
  infra:    { label: "Infra view", icon: "graph", cls: "from-emerald-500/20 to-emerald-950/40 text-emerald-300 ring-emerald-400/30", glow: "shadow-[0_0_14px_rgba(52,211,153,0.15)]" },
};

function SkillChip({ id }) {
  const m = SKILL_META[id] ?? { label: id, icon: "scan", cls: "from-slate-500/20 to-slate-900/40 text-slate-300 ring-slate-400/30", glow: "" };
  return h("span",
    { className: `inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-gradient-to-br px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${m.cls} ${m.glow}` },
    h(Icon, { name: m.icon, className: "h-3 w-3" }),
    m.label,
  );
}

function Ask({ log, busy, onSend, provider, setProvider, lastAsst, oc, ocBusy, ocRun, prefill, onConsumePrefill }) {
  const [q, setQ] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    if (prefill) {
      setQ(prefill);
      onConsumePrefill();
    }
  }, [prefill]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy]);

  const send = () => {
    const question = q.trim();
    if (!question || busy) return;
    onSend(question);
    setQ("");
  };

  const managed = oc?.managed;
  const showOc = provider === "opencode" || managed?.running;

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-4 py-4" },
      h("div", { className: "mx-auto flex max-w-3xl flex-col gap-3" },
        log.length === 0
          ? h("div", { className: "fade-in flex flex-col items-center gap-4 pt-8 text-center" },
              h("div", { className: "flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-300" }, h(Icon, { name: "message", className: "h-7 w-7" })),
              h("div", null,
                h("div", { className: "text-base font-semibold text-slate-100" }, "Ask about your infrastructure"),
                h("div", { className: "mt-1 max-w-md text-[13px] text-slate-500" },
                  "Grounded in the Neo4j graph and latest snapshot. Try one of these:"),
              ),
              h("div", { className: "grid w-full max-w-lg gap-2 sm:grid-cols-2" },
                SUGGESTIONS.map((s) =>
                  h("button", { key: s, className: "btn justify-start text-left", onClick: () => onSend(s) },
                    h(Icon, { name: "zap", className: "h-3.5 w-3.5 shrink-0 text-indigo-300" }),
                    h("span", { className: "truncate" }, s),
                  ),
                ),
              ),
            )
          : log.map((m, i) =>
              m.role === "user"
                ? h("div", { key: i, className: "bubble-user max-w-[85%] self-end whitespace-pre-wrap" }, m.text)
                : h("div", { key: i, className: "fade-in max-w-[85%] self-start" },
                    h("div", { className: "mb-1 flex flex-wrap items-center gap-1.5 px-1" },
                      h("span", { className: `inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[10.5px] font-medium tracking-wide ${PMETA[m.provider]?.badge ?? "border-white/15 bg-white/5 text-slate-400"}` }, PMETA[m.provider]?.label ?? m.provider ?? "assistant"),
                      m.model ? h("span", { className: "font-mono text-[10.5px] text-slate-500" }, m.model) : null,
                      m.latency != null ? h("span", { className: "text-[10.5px] text-slate-600" }, `${(m.latency / 1000).toFixed(1)}s`) : null,
                      m.context ? h("span", { className: "text-[10.5px] text-slate-600" }, `${m.context.resources > 0 ? m.context.resources + " resources · " : ""}${m.context.findings} findings`) : null,
                      m.note
                        ? h("span", { className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-px font-mono text-[10.5px] text-amber-300/90" }, m.note)
                        : null,
                    ),
                    m.context?.skills?.length
                      ? h("div", { className: "mb-1.5 flex flex-wrap items-center gap-1.5 px-1" },
                          m.context.skills.map((sk) => h(SkillChip, { key: sk, id: sk })),
                        )
                      : null,
                    h("div", { className: "bubble-ai" },
                      h(Md, { text: m.text, className: "fade-in" }),
                    ),
                  ),
            ),
        busy
          ? h("div", { className: "bubble-ai max-w-[85%] self-start" },
              h("div", { className: "flex items-center gap-2 text-slate-400" },
                h("span", { className: "text-[12px]" }, "Thinking"),
                h("span", { className: "flex gap-0.5" },
                  [0, 1, 2].map((i) => h("span", {
                    key: i,
                    className: "h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400",
                    style: { animationDelay: `${i * 0.15}s` },
                  })),
                ),
              ),
            )
          : null,
        h("div", { ref: endRef }),
      ),
    ),
    h("div", { className: "shrink-0 border-t border-white/10 px-4 pb-4 pt-3" },
      h("div", { className: "mx-auto max-w-3xl" },
        h("div", { className: "flex items-center gap-2 rounded-xl border border-white/10 bg-ink-900 p-2 focus-within:border-indigo-400/40 focus-within:ring-2 focus-within:ring-indigo-400/20" },
          h("input", {
            className: "min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-200 outline-none placeholder:text-slate-600",
            placeholder: "Ask about posture, exposure, encryption, flow logs, or a specific resource…",
            value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") send(); },
          }),
          h("select", { className: "select shrink-0", value: provider, onChange: (e) => setProvider(e.target.value), title: "provider" },
            h("option", { value: "auto" }, "auto"),
            ["heuristic", "bedrock", "openrouter", "opencode"].map((p) => h("option", { key: p, value: p }, p)),
          ),
          h("button", { className: "btn-primary shrink-0", disabled: busy || !q.trim(), onClick: send },
            busy ? h(Icon, { name: "refresh", className: "h-3.5 w-3.5 animate-spin" }) : h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" }),
            h("span", { className: "hidden sm:inline" }, busy ? "Thinking" : "Ask"),
          ),
        ),
        h("div", { className: "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-slate-500" },
          h("span", null, "Engine:", " ", h("span", { className: "font-medium text-slate-300" }, provider === "auto" ? "auto" : PMETA[provider]?.label ?? provider)),
          lastAsst
            ? h(Fragment, null,
                h("span", null, "resolved: ", h("span", { className: "font-medium text-slate-300" }, PMETA[lastAsst.provider]?.label ?? lastAsst.provider)),
                lastAsst.model ? h("span", null, " · ", lastAsst.model) : null,
                lastAsst.context ? h("span", null, ` · ${lastAsst.context.resources > 0 ? lastAsst.context.resources + " resources " : ""}· ${lastAsst.context.findings} findings`) : null,
                lastAsst.context?.skills?.length
                  ? h("span", { className: "flex flex-wrap items-center gap-1.5" },
                      lastAsst.context.skills.map((sk) => h(SkillChip, { key: sk, id: sk })),
                    )
                  : null,
              )
            : h("span", { className: "text-slate-600" }, "send a question to see what answered"),
        ),
        showOc
          ? h("div", { className: "mt-2 flex items-center gap-2 px-1" },
              h("span", { className: cx("h-1.5 w-1.5 shrink-0 rounded-full", managed?.running ? "bg-emerald-400" : "bg-slate-500") }),
              h("span", { className: "min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500" },
                managed?.running ? `opencode agent @ ${managed.url}` : "opencode agent stopped"),
              h("button", {
                className: "btn !py-1 text-[11px]",
                onClick: () => ocRun(!managed?.running),
                disabled: ocBusy,
              }, ocBusy ? "…" : managed?.running ? "stop" : "start"),
            )
          : null,
      ),
    ),
  );
}

/* ============================================================ */
/*  DRIFT (Diff)                                                  */
/* ============================================================ */
function DeepJson({ v }) {
  if (v === null || v === undefined) return h("span", { className: "font-mono text-slate-500" }, "\u2205");
  let s;
  if (typeof v === "object") {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else { s = String(v); }
  if (s.length > 220) s = s.slice(0, 220) + "\u2026";
  return h("span", { className: "font-mono break-all text-slate-300" }, s);
}

function LineRows({ lines }) {
  return lines.map((l, i) => {
    if (l.status === "same") {
      return h("div", { key: i, className: "flex gap-2 px-3 py-px font-mono text-[12px] leading-relaxed text-slate-600" },
        h("span", { className: "w-4 shrink-0 text-center" }, " "),
        h("span", { className: "min-w-[130px] text-slate-500" }, l.path),
        h(DeepJson, { v: l.to }));
    }
    if (l.status === "add") {
      return h("div", { key: i, className: "flex gap-2 bg-emerald-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-emerald-400" }, "+"),
        h("span", { className: "min-w-[130px] text-emerald-200/80" }, l.path),
        h(DeepJson, { v: l.to }));
    }
    if (l.status === "del") {
      return h("div", { key: i, className: "flex gap-2 bg-red-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-red-400" }, "\u2212"),
        h("span", { className: "min-w-[130px] text-red-200/70" }, l.path),
        h(DeepJson, { v: l.from }));
    }
    return h(Fragment, { key: i },
      h("div", { className: "flex gap-2 bg-red-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-red-400" }, "\u2212"),
        h("span", { className: "min-w-[130px] text-red-200/70" }, l.path),
        h(DeepJson, { v: l.from })),
      h("div", { className: "flex gap-2 bg-emerald-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-emerald-400" }, "+"),
        h("span", { className: "min-w-[130px] text-emerald-200/80" }, l.path),
        h(DeepJson, { v: l.to })),
    );
  });
}

function AttrChip({ a }) {
  if (!a) return null;
  const who = a.user_arn || a.username || a.access_key_id || "unknown";
  return h("span", {
    className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-200/90",
    title: `${a.event_time}${a.source_ip ? " \u00b7 from " + a.source_ip : ""}`,
  },
    h(Icon, { name: "key", className: "h-3 w-3" }),
    a.event_name,
    " \u00b7 ",
    who);
}

const DIFF_COLOR = {
  add: { chip: "text-emerald-400", ring: "border-emerald-400/40 bg-emerald-400/10", txt: "text-emerald-300" },
  del: { chip: "text-red-400",     ring: "border-red-400/40 bg-red-400/10",     txt: "text-red-300" },
  chg: { chip: "text-amber-300",   ring: "border-amber-300/40 bg-amber-300/10", txt: "text-amber-200" },
};

function ResourceBlock({ it, color, opened, onToggle }) {
  const c = DIFF_COLOR[color];
  const chip = color === "add" ? "+" : color === "del" ? "\u2212" : "~";
  const short = (k) => (k ?? "").split("/").pop();
  return h("div", {
    className: cx("overflow-hidden rounded-xl border transition", opened ? c.ring : "border-white/10 bg-ink-850/70"),
  },
    h("div", { onClick: onToggle, className: "flex cursor-pointer select-none items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-white/5" },
      h("span", { className: cx("text-[13px] font-bold", c.chip) }, chip),
      h("span", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-500" }, it.label),
      h("span", { className: "min-w-0 flex-1 truncate font-mono text-[12.5px] text-slate-200" }, it.name || short(it.key)),
      h("span", { className: "hidden font-mono text-[11px] text-slate-500 sm:inline" }, short(it.key)),
      h(AttrChip, { a: it.attributed_by }),
      h(Icon, { name: "chevron", className: cx("h-4 w-4 shrink-0 text-slate-500 transition", opened && "rotate-180") }),
    ),
    opened
      ? h("div", { className: "max-h-96 overflow-y-auto border-t border-white/10 py-1" }, h(LineRows, { lines: it.lines }))
      : null,
  );
}

function DiffGroup({ title, count, items, color, open, toggle }) {
  if (!count) return null;
  const c = DIFF_COLOR[color];
  return h("div", { className: "space-y-1.5" },
    h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
      h("span", { className: cx("h-2 w-2 rounded-full", { add: "bg-emerald-400", del: "bg-red-400", chg: "bg-amber-300" }[color]) }),
      h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, title),
      h("span", { className: cx("font-mono text-[11px]", c.chip) }, count),
    ),
    items.map((it) => h(ResourceBlock, { key: it.key, it, color, opened: !!open[it.key], onToggle: () => toggle(it.key) })),
    count > items.length
      ? h("div", { className: "px-1 pt-1 text-[11px] text-slate-600" }, `\u2026 and ${count - items.length} more not shown`)
      : null,
  );
}

function Diff() {
  const [snaps, setSnaps] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState({});

  useEffect(() => {
    fetch("/api/snapshots").then((r) => r.json()).then((s) => {
      setSnaps(s);
      setFrom(s.length > 1 ? s[1].id : s[0]?.id ?? "");
      setTo(s[0]?.id ?? "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!from || !to || from === to) { setData(null); return; }
    fetch(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => r.json()).then((d) => { setData(d.error ? null : d); setErr(d.error ?? null); setOpen({}); })
      .catch((e) => setErr(String(e)));
  }, [from, to]);

  const swap = () => { setFrom(to); setTo(from); };
  const toggle = (key) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const allOpen = Object.values(open).reduce((a, b) => a && b, Object.keys(open).length > 0);
  const setAll = (v) => {
    const next = {};
    for (const s of [...data?.nodes_added.items ?? [], ...data?.nodes_removed.items ?? [], ...data?.nodes_changed.items ?? []]) next[s.key] = v;
    setOpen(next);
  };

  const doExport = async (fmt) => {
    const r = await fetch(`/api/diff/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=${fmt}`);
    const blob = await r.blob();
    const aEl = document.createElement("a");
    aEl.href = URL.createObjectURL(blob);
    aEl.download = `awsome-drift-${from}-to-${to}.${fmt === "md" ? "md" : "json"}`;
    aEl.click();
    URL.revokeObjectURL(aEl.href);
  };

  const fm = data?.meta?.from, tm = data?.meta?.to;
  const owner = (m) => m ? `${m.user ?? "?"}@${m.hostname ?? "?"} (${m.trigger ?? "manual"})` : "?";
  const c = data?.counts;
  const statCard = (label, n, cls) =>
    h("div", { className: "card px-3 py-2.5" },
      h("div", { className: cx("font-mono text-xl font-bold", cls) }, n),
      h("div", { className: "kpi-label" }, label));

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "shrink-0 border-b border-white/10 px-6 py-3" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("label", { className: "kpi-label" }, "From"),
        h("select", { className: "select font-mono text-[11.5px]", value: from, onChange: (e) => setFrom(e.target.value) },
          snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
        h("button", { className: "btn-ghost p-1.5", title: "swap", onClick: swap }, h(Icon, { name: "swap", className: "h-4 w-4" })),
        h("label", { className: "kpi-label" }, "To"),
        h("select", { className: "select font-mono text-[11.5px]", value: to, onChange: (e) => setTo(e.target.value) },
          snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
        h("span", { className: "mx-1 hidden h-5 w-px bg-white/10 sm:inline" }),
        h("span", { className: "chip text-emerald-300" }, "+ added"),
        h("span", { className: "chip text-red-300" }, "\u2212 removed"),
        h("span", { className: "chip text-amber-200" }, "~ changed"),
        h("span", { className: "flex-1" }),
        data
          ? h(Fragment, null,
              h("button", { className: "btn", onClick: () => setAll(!allOpen) }, allOpen ? "collapse all" : "expand all"),
              h("button", { className: "btn", onClick: () => doExport("md") }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), ".md"),
              h("button", { className: "btn", onClick: () => doExport("json") }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), ".json"),
            )
          : null,
      ),
      data
        ? h("div", { className: "mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500" },
            h("span", { className: "font-mono" }, `taken ${owner(fm)}  \u2192  taken ${owner(tm)}`),
            data.trail?.attributed
              ? h("span", { className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-200/90" },
                  h(Icon, { name: "key", className: "h-3 w-3" }), `${data.trail.attributed} changes attributed via CloudTrail`)
              : h("span", { className: "font-mono text-slate-600" },
                  `trail: ${data.trail?.available_from ? data.trail.events_from + " ev" : "unavailable"} \u2192 ${data.trail?.available_to ? data.trail.events_to + " ev" : "unavailable"}`),
          )
        : null,
    ),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-6 py-4" },
      data
        ? h("div", { className: "mx-auto max-w-5xl" },
            h("div", { className: "grid grid-cols-4 gap-3 sm:grid-cols-8" },
              statCard("added", c.nodes_added, "text-emerald-400"),
              statCard("removed", c.nodes_removed, "text-red-400"),
              statCard("changed", c.nodes_changed, "text-amber-300"),
              statCard("edges +", c.edges_added, "text-emerald-400"),
              statCard("edges \u2212", c.edges_removed, "text-red-400"),
              statCard("findings +", c.findings_added, "text-emerald-400"),
              statCard("findings \u2212", c.findings_removed, "text-red-400"),
              statCard("findings ~", c.findings_changed, "text-amber-300"),
            ),
            h(DiffGroup, { title: "Added resources", count: c.nodes_added, items: data.nodes_added.items, color: "add", open, toggle }),
            h(DiffGroup, { title: "Removed resources", count: c.nodes_removed, items: data.nodes_removed.items, color: "del", open, toggle }),
            h(DiffGroup, { title: "Changed resources", count: c.nodes_changed, items: data.nodes_changed.items, color: "chg", open, toggle }),
            (c.edges_added || c.edges_removed)
              ? h("div", { className: "space-y-1.5" },
                  h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
                    h("span", { className: "h-2 w-2 rounded-full bg-emerald-400" }),
                    h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, "Edges"),
                    h("span", { className: "font-mono text-[11px] text-emerald-400" }, `+${c.edges_added}`),
                    h("span", { className: "font-mono text-[11px] text-red-400" }, `\u2212${c.edges_removed}`),
                  ),
                  data.edges_added.items.map((e) => h(edgeRow, { key: e.from + e.to + e.type, e, color: "add" })),
                  data.edges_removed.items.map((e) => h(edgeRow, { key: e.from + e.to + e.type, e, color: "del" })),
                )
              : null,
            (c.findings_added || c.findings_removed || c.findings_changed)
              ? h("div", { className: "space-y-1.5" },
                  h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
                    h("span", { className: "h-2 w-2 rounded-full bg-indigo-400" }),
                    h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, "Findings"),
                    h("span", { className: "font-mono text-[11px] text-emerald-400" }, `+${c.findings_added}`),
                    h("span", { className: "font-mono text-[11px] text-red-400" }, `\u2212${c.findings_removed}`),
                    h("span", { className: "font-mono text-[11px] text-amber-300" }, `~${c.findings_changed}`),
                  ),
                  [...data.findings_added.items.map((f) => [f, "add"]),
                   ...data.findings_removed.items.map((f) => [f, "del"]),
                   ...data.findings_changed.items.map((f) => [f, "chg"])]
                    .map(([f, colr]) => h(findingRow, { key: f.id, f, color: colr })),
                )
              : null,
            !c.nodes_added && !c.nodes_removed && !c.nodes_changed && !c.edges_added && !c.edges_removed && !c.findings_added && !c.findings_removed && !c.findings_changed
              ? h("div", { className: "flex h-48 flex-col items-center justify-center gap-2 text-center" },
                  h("Icon", { name: "drift", className: "h-8 w-8 text-emerald-300/70" }),
                  h("div", { className: "text-sm font-medium text-slate-300" }, "No drift between these snapshots"),
                  h("div", { className: "text-[12px] text-slate-500" }, "The account state is identical."),
                )
              : null,
          )
        : err
          ? h("div", { className: "mx-auto max-w-5xl pt-16 text-center text-sm text-slate-500" }, `diff: ${err}`)
          : h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" }, "pick two snapshots or run a scan first"),
    ),
  );
}

function edgeRow({ e, color }) {
  const txt = color === "add" ? "text-emerald-300" : "text-red-300";
  return h("div", { className: "flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 font-mono text-[12px]" },
    h("span", { className: cx("font-bold", { add: "text-emerald-400", del: "text-red-400" }[color]) }, color === "add" ? "+" : "\u2212"),
    h("span", { className: "truncate text-slate-300" }, shortKey(e.from)),
    h("span", { className: "shrink-0 text-slate-500" }, `\u2013[${e.type}]\u2192`),
    h("span", { className: "truncate text-slate-300" }, shortKey(e.to)),
  );
}

function findingRow({ f, color }) {
  const sevC = SEV[f.severity] ?? SEV.info;
  return h("div", { className: "flex items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[12.5px]" },
    h("span", { className: cx("font-bold", { add: "text-emerald-400", del: "text-red-400", chg: "text-amber-300" }[color]) }, { add: "+", del: "\u2212", chg: "~" }[color]),
    h("span", { className: cx("sevdot", sevC.dot) }),
    h("span", { className: "min-w-0 flex-1 truncate font-mono text-slate-300" }, f.rule),
    h("span", { className: "hidden truncate text-slate-500 sm:inline" }, f.resource_name || shortKey(f.resource_key)),
    h(AttrChip, { a: f.attributed_by }),
  );
}

/* ============================================================ */
/*  APP SHELL                                                     */
/* ============================================================ */
const NAV = [
  { label: "Overview", items: [["summary", "Summary", "dashboard"]] },
  { label: "Investigate", items: [["diagram", "Graph", "graph"], ["findings", "Findings", "alert"], ["diff", "Drift", "drift"]] },
  { label: "Operate", items: [["scans", "Scans", "scan"]] },
  { label: "Assist", items: [["ask", "Copilot", "message"]] },
];
const PAGE = {
  summary: ["Summary", "Security posture across your account"],
  diagram: ["Graph", "Resource topology rendered from Neo4j"],
  findings: ["Findings", "Issues and controls on the latest snapshot"],
  scans: ["Scans", "Snapshot pipeline and job history"],
  diff: ["Drift", "Snapshot-to-snapshot change detector"],
  ask: ["Copilot", "Grounded answers about your infrastructure"],
};

function App() {
  const [tab, setTab] = useState("summary");
  const [summary, setSummary] = useState(null);
  const [graph, setGraph] = useState(null);
  const [findings, setFindings] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [wsOk, setWsOk] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  // Architecture is the default: the containment view is what people mean by
  // "the diagram". Flow stays available for dependency tracing.
  const [diagView, setDiagView] = useState("arch");
  const [findingGraph, setFindingGraph] = useState(null);
  const [snaps, setSnaps] = useState([]);
  const [showDiffOv, setShowDiffOv] = useState(false);
  const [diffOv, setDiffOv] = useState(null);
  const [dfrom, setDFrom] = useState("");
  const [dto, setDTo] = useState("");
  const [findingSev, setFindingSev] = useState(null);
  const [askLog, setAskLog] = useState([]);
  const [askBusy, setAskBusy] = useState(false);
  const [askProvider, setAskProvider] = useState("auto");
  const [askPrefill, setAskPrefill] = useState(null);
  const [oc, setOc] = useState(null);
  const [ocBusy, setOcBusy] = useState(false);

  useEffect(() => {
    fetch("/api/snapshots").then((r) => r.json()).then((s) => {
      setSnaps(s);
      setDFrom(s.length > 1 ? s[1].id : s[0]?.id ?? "");
      setDTo(s[0]?.id ?? "");
    }).catch(() => {});
    fetch("/api/opencode").then((r) => r.json()).then(setOc).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(console.error);
    // An error response still parses as JSON, so .catch() never fires — keep
    // jobs an array no matter what the endpoint answers.
    fetch("/api/jobs").then((r) => r.json())
      .then((d) => setJobs(Array.isArray(d) ? d : []))
      .catch(() => setJobs([]));
    fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(() => {});
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`);
    ws.onopen = () => setWsOk(true);
    ws.onclose = () => setWsOk(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "jobs" && Array.isArray(msg.jobs)) {
          setJobs((prev) => {
            const before = new Map((prev ?? []).map((j) => [j.id, j.status]));
            const after = new Map(msg.jobs.map((j) => [j.id, j.status]));
            let settled = false;
            for (const [id, st] of before) {
              if (st && (st === "queued" || st === "running" || st === "cancelling") && after.get(id) !== st) settled = true;
            }
            if (settled) {
              fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(() => {});
              fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(() => {});
            }
            return msg.jobs;
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  const go = (name, arg) => {
    if (name === "findings") { setFindingSev(arg?.sev ?? null); setTab("findings"); return; }
    if (name === "ask") { if (arg?.q) setAskPrefill(arg.q); setTab("ask"); return; }
    setTab(name);
  };

  const askAbout = (f) =>
    go("ask", { q: `Explain finding "${f.rule}" on ${f.resource_name || shortKey(f.resource_key)} and how I fix it.` });

  const run = async (regions) => {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `scan failed (${res.status})`);
    const job = await res.json();
    setJobs((prev) => [job, ...(prev ?? [])]);
  };
  const act = async (id, action) => {
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error ?? `${action} failed`);
    const job = await res.json();
    setJobs((prev) => prev.map((j) => j.id === job.id ? job : j));
  };

  const askSend = async (question) => {
    if (!question.trim() || askBusy) return;
    setAskLog((l) => [...l, { role: "user", text: question }]);
    setAskBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, provider: askProvider !== "auto" ? askProvider : undefined }),
      });
      const d = await res.json();
      setAskLog((l) => [...l, { role: "assistant", text: d.answer ?? d.error, provider: d.provider, model: d.model, latency: d.latency_ms, context: d.context, note: d.note }]);
    } catch (e) {
      setAskLog((l) => [...l, { role: "assistant", text: `error: ${e.message}`, provider: "error" }]);
    } finally {
      setAskBusy(false);
    }
  };

  const ocRun = async (start) => {
    setOcBusy(true);
    try {
      const r = await fetch(start ? "/api/opencode/start" : "/api/opencode/stop", { method: "POST" }).then((r) => r.json());
      setOc((o) => (o ? { ...o, managed: r } : o));
    } catch { /* keep state */ }
    setOcBusy(false);
    try { setOc(await fetch("/api/opencode").then((r) => r.json())); } catch { /* ignore */ }
  };

  const toggleFindings = async () => {
    const next = !showFindings;
    setShowFindings(next);
    if (next && !findingGraph) {
      try { const r = await fetch("/api/graph/findings"); setFindingGraph(await r.json()); } catch { /* ignore */ }
    }
  };
  const loadDiffOv = async (f, t) => {
    const r = await fetch(`/api/diff?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`);
    const d = await r.json();
    if (!d.error) setDiffOv(d);
  };
  const toggleDiffOv = async () => {
    const next = !showDiffOv;
    setShowDiffOv(next);
    if (next) {
      const f = dfrom || snaps[1]?.id, t = dto || snaps[0]?.id;
      if (f && t && f !== t) await loadDiffOv(f, t);
    }
  };
  const onDFrom = (e) => { const v = e.target.value; setDFrom(v); if (showDiffOv && v && dto && v !== dto) loadDiffOv(v, dto); };
  const onDTo = (e) => { const v = e.target.value; setDTo(v); if (showDiffOv && dfrom && v && dfrom !== v) loadDiffOv(dfrom, v); };

  useEffect(() => {
    if (tab !== "diagram") return;
    fetch("/api/graph").then((r) => r.json()).then(setGraph).catch(console.error);
  }, [tab]);

  useEffect(() => {
    if (tab !== "findings") return;
    fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(console.error);
  }, [tab]);

  const p = posture(summary?.findings);
  const ftotal = summary?.findings?.total ?? 0;
  const latest = summary?.latest_snapshot;
  const [ptitle, psub] = PAGE[tab] ?? ["", ""];
  const lastAsst = [...askLog].reverse().find((m) => m.role === "assistant") ?? null;
  const pane = (key, children) =>
    h("div", { className: cx("h-full", tab === key ? "flex flex-col" : "hidden") }, children);

  return h("div", { className: "flex h-screen overflow-hidden" },
    /* sidebar */
    h("aside", { className: "flex w-60 shrink-0 flex-col border-r border-white/10 bg-ink-900/70" },
      h("div", { className: "flex items-center gap-3 px-4 pb-4 pt-5" },
        h("div", { className: "flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 font-mono text-sm font-bold text-white shadow-lg shadow-indigo-950/60" }, "A"),
        h("div", { className: "leading-tight" },
          h("div", { className: "text-[15px] font-bold tracking-tight text-slate-100" }, "AWSome"),
          h("div", { className: "text-[10.5px] uppercase tracking-widest text-slate-500" }, "infra intelligence"),
        ),
      ),
      h("nav", { className: "flex-1 space-y-4 overflow-y-auto px-3 py-2" },
        NAV.map((group) =>
          h("div", { key: group.label },
            h("div", { className: "kpi-label px-3 pb-1.5" }, group.label),
            group.items.map(([key, label, icon]) =>
              h("button", { key, className: cx("navitem", tab === key && "navitem-active"), onClick: () => setTab(key) },
                h(Icon, { name: icon, className: cx("h-4 w-4", tab === key ? "text-indigo-300" : "text-slate-500") }),
                label),
            ),
          ),
        ),
      ),
      h("div", { className: "space-y-1.5 border-t border-white/10 p-3" },
        h("div", { className: "flex items-center gap-2 px-1 text-[11px] text-slate-500" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", summary?.neo4j?.url ? "bg-emerald-400" : "bg-slate-500") }),
          summary?.neo4j?.url ? "neo4j connected" : "neo4j offline",
        ),
        h("div", { className: "flex items-center gap-2 px-1 text-[11px] text-slate-500" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", wsOk ? "bg-emerald-400" : "bg-slate-500") }),
          wsOk ? "scanner live" : "scanner offline",
        ),
        latest
          ? h("div", { className: "mt-1 truncate font-mono text-[10px] text-slate-600" }, latest.id)
          : h("div", { className: "mt-1 px-1 text-[10px] text-slate-600" }, "no snapshot yet"),
      ),
    ),
    /* main column */
    h("div", { className: "flex min-w-0 flex-1 flex-col" },
      h("header", { className: "flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6" },
        h("div", { className: "min-w-0" },
          h("h1", { className: "text-[15px] font-bold tracking-tight text-slate-100" }, ptitle),
          h("p", { className: "truncate text-[11.5px] text-slate-500" }, psub),
        ),
        h("div", { className: "flex shrink-0 items-center gap-2" },
          ftotal > 0
            ? h("button", {
                className: "chip hover:bg-white/10",
                onClick: () => { setFindingSev(null); setTab("findings"); },
                title: "open findings",
              },
              h("span", { className: cx("sevdot", (SEV[p ? (fcountCrit(summary) ? "critical" : fcountHigh(summary) ? "high" : "medium") : "info"] ?? SEV.info).dot) }),
              h("span", { className: "font-mono" }, p.grade),
              h("span", { className: "text-slate-500" }, ftotal, " findings"),
            )
            : h("span", { className: "chip text-emerald-300" }, "clean"),
          h("button", { className: "btn shrink-0", onClick: () => setTab("scans") }, h(Icon, { name: "play", className: "h-3.5 w-3.5" }), h("span", { className: "hidden sm:inline" }, "Run scan")),
        ),
      ),
      h("main", { className: "min-h-0 flex-1" },
        pane("summary", h(Summary, { summary, findingsData: findings, jobs, go })),
        pane("diagram",
          h("div", { className: "flex h-full min-h-0 flex-col" },
            h("div", { className: "flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2" },
              h("div", { className: "flex items-center gap-1 rounded-lg border border-white/10 p-0.5" },
                ["arch", "flow"].map((v) =>
                  h("button", {
                    key: v,
                    className: cx("toggle border-0", diagView === v ? "toggle-on" : "toggle-off"),
                    onClick: () => setDiagView(v),
                    title: v === "arch"
                      ? "AWS architecture view — VPC and subnet boundaries, resources nested inside"
                      : "Flow view — dependency graph, laid out left to right",
                  }, v === "arch" ? "architecture" : "flow")
                ),
              ),
              h("button", { className: cx("toggle", showFindings ? "toggle-on" : "toggle-off"), onClick: toggleFindings },
                h(Icon, { name: "alert", className: "h-3.5 w-3.5" }), "findings"),
              h("button", { className: cx("toggle", showDiffOv ? "toggle-on" : "toggle-off"), onClick: toggleDiffOv },
                h(Icon, { name: "drift", className: "h-3.5 w-3.5" }), "drift"),
              showDiffOv
                ? h(Fragment, null,
                    h("select", { className: "select font-mono text-[11px]", value: dfrom, onChange: onDFrom },
                      snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
                    h("span", { className: "text-slate-500" }, "\u2192"),
                    h("select", { className: "select font-mono text-[11px]", value: dto, onChange: onDTo },
                      snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
                    diffOv
                      ? h("span", { className: "ml-1 font-mono text-[11px] text-slate-500" },
                          h("span", { className: "text-emerald-400" }, `+${diffOv.counts.nodes_added}`),
                          " ",
                          h("span", { className: "text-red-400" }, `\u2212${diffOv.counts.nodes_removed}`),
                          " ",
                          h("span", { className: "text-amber-300" }, `~${diffOv.counts.nodes_changed}`),
                        )
                      : null,
                  )
                : null,
            ),
            h("div", { className: "min-h-0 flex-1" },
              h(Diagram, {
                graph,
                findingsGraph: showFindings ? findingGraph : null,
                diffOverlay: showDiffOv ? diffOv : null,
                view: diagView,
                region: (summary?.regions ?? [])[0],
              })),
          ),
        ),
        pane("findings", h(Findings, { data: findings, sev: findingSev, setSev: setFindingSev, onAsk: askAbout })),
        pane("scans", h(Scans, { jobs, connected: wsOk, run, act, scannedRegions: (summary?.regions ?? []).join(",") })),
        pane("ask", h(Ask, {
          log: askLog, busy: askBusy, onSend: askSend,
          provider: askProvider, setProvider: setAskProvider, lastAsst,
          oc, ocBusy, ocRun,
          prefill: askPrefill, onConsumePrefill: () => setAskPrefill(null),
        })),
        pane("diff", h(Diff)),
      ),
    ),
  );
}

function fcountCrit(s) { return s?.findings?.bySeverity?.critical > 0; }
function fcountHigh(s) { return s?.findings?.bySeverity?.high > 0; }

createRoot(document.getElementById("root")).render(h(App));
