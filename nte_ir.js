/* =============================================================
   DEPOT/OS — NTE / IR Violation Management Module
   Integrates with the main app via window.NteIr.integrate()
============================================================= */
(function () {
  const VIOLATION_CATEGORIES = [
    "Attendance / Tardiness", "Inventory Discrepancy", "Safety Violation",
    "Policy Breach", "Misconduct", "Damage to Property", "Theft / Pilferage",
    "Insubordination", "Negligence", "Other",
  ];
  const DEPARTMENTS = [
    "Warehouse", "Sales Floor", "Receiving", "Shipping", "Administration", "Maintenance", "Other",
  ];
  const SEVERITIES = ["Minor", "Major", "Critical"];
  const STORAGE_BUCKET = "violation-files";
  const JSPDF_AUTOTABLE_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

  function esc(s) {
    const fn = window._nteIrCtx?.esc;
    if (typeof fn === "function") return fn(s);
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  }

  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function storageBucket(ctx) {
    return ctx.sb?.storage?.from(STORAGE_BUCKET) || null;
  }

  function defaultNteIrState() {
    return {
      nteIrTab: "dashboard",
      nteIrFilters: { q: "", department: "all", category: "all", status: "all", severity: "all", reporter: "all", dateFrom: "", dateTo: "" },
      nteIrForm: null,
      nteIrSelectedId: null,
      nteIrHistoryEmployee: null,
      nteIrEditId: null,
    };
  }

  function mapViolationRow(r) {
    return {
      id: r.id, caseType: r.case_type, employeeId: r.employee_id, employeeName: r.employee_name,
      position: r.position || "", department: r.department || "",
      reporterId: r.reporter_id, reporterName: r.reporter_name, reporterRole: r.reporter_role,
      category: r.category, severity: r.severity,
      violationDate: r.violation_date, violationTime: r.violation_time || "", location: r.location || "",
      description: r.description, additionalInfo: r.additional_info || "", remarks: r.remarks || "",
      attachments: r.attachments || [], status: r.status, approvalStatus: r.approval_status,
      violationCount: r.violation_count || 0,
      explanationPdf: r.explanation_pdf || "", sanctionPdf: r.sanction_pdf || "",
      policyViolated: r.policy_violated || "", explanationDeadline: r.explanation_deadline || "",
      relatedIrIds: r.related_ir_ids || [], parentCaseId: r.parent_case_id || "",
      workflowHistory: r.workflow_history || [],
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  function toDbRow(c) {
    return {
      id: c.id, case_type: c.caseType, employee_id: c.employeeId, employee_name: c.employeeName,
      position: c.position, department: c.department,
      reporter_id: c.reporterId, reporter_name: c.reporterName, reporter_role: c.reporterRole,
      category: c.category, severity: c.severity,
      violation_date: c.violationDate, violation_time: c.violationTime, location: c.location,
      description: c.description, additional_info: c.additionalInfo, remarks: c.remarks,
      attachments: c.attachments, status: c.status, approval_status: c.approvalStatus,
      violation_count: c.violationCount,
      explanation_pdf: c.explanationPdf, sanction_pdf: c.sanctionPdf,
      policy_violated: c.policyViolated, explanation_deadline: c.explanationDeadline || null,
      related_ir_ids: c.relatedIrIds, parent_case_id: c.parentCaseId || null,
      workflow_history: c.workflowHistory,
      updated_at: new Date().toISOString(),
    };
  }

  function statusLabel(s) {
    const map = {
      filed: "Filed", pending_approval: "Pending Approval", approved: "Approved", rejected: "Rejected",
      nte_generated: "NTE Generated", waiting_explanation: "Waiting for Explanation",
      explanation_uploaded: "Explanation Uploaded", sanction_uploaded: "Sanction Uploaded", completed: "Completed",
    };
    return map[s] || s;
  }

  function statusTag(s) {
    const cls = s === "completed" || s === "approved" ? "tag-ok"
      : s === "rejected" ? "tag-danger"
      : s === "waiting_explanation" || s === "pending_approval" ? "tag-violet"
      : s === "sanction_uploaded" || s === "explanation_uploaded" ? "tag-accent"
      : "";
    return `<span class="tag ${cls}">${esc(statusLabel(s))}</span>`;
  }

  function severityTag(sev) {
    const cls = sev === "Critical" ? "tag-danger" : sev === "Major" ? "tag-accent" : "";
    return `<span class="tag ${cls}">${esc(sev)}</span>`;
  }

  function todayKey() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date()).replace(/-/g, "");
  }

  function generateCaseNumber(prefix, existing) {
    const day = todayKey();
    const pat = new RegExp(`^${prefix}-${day}-(\\d{4})$`);
    let max = 0;
    (existing || []).forEach(c => {
      const m = c.id.match(pat);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `${prefix}-${day}-${String(max + 1).padStart(4, "0")}`;
  }

  function addWorkflow(c, action, note) {
    const ctx = window._nteIrCtx;
    c.workflowHistory = c.workflowHistory || [];
    c.workflowHistory.unshift({
      action, note: note || "", by: ctx.state.session.name, role: ctx.state.session.role,
      timestamp: ctx.fmt(0),
    });
  }

  function approvedIrCount(employeeId, violations) {
    return violations.filter(v => v.caseType === "IR" && v.employeeId === employeeId && v.approvalStatus === "approved").length;
  }

  function visibleViolations(state) {
    const admin = state.session.role === "Admin";
    if (admin) return state.violations;
    return state.violations.filter(v => v.reporterId === state.session.id || v.employeeId === state.session.id);
  }

  function filteredViolations(state) {
    const f = state.nteIrFilters;
    const q = (f.q || "").toLowerCase();
    return visibleViolations(state).filter(v => {
      if (q && !v.id.toLowerCase().includes(q) && !v.employeeName.toLowerCase().includes(q)
        && !v.employeeId.toLowerCase().includes(q) && !v.description.toLowerCase().includes(q)) return false;
      if (f.department !== "all" && v.department !== f.department) return false;
      if (f.category !== "all" && v.category !== f.category) return false;
      if (f.status !== "all" && v.status !== f.status) return false;
      if (f.severity !== "all" && v.severity !== f.severity) return false;
      if (f.reporter !== "all" && v.reporterName !== f.reporter) return false;
      if (f.dateFrom && v.violationDate < f.dateFrom) return false;
      if (f.dateTo && v.violationDate > f.dateTo) return false;
      return true;
    });
  }

  function nteIrAnalytics(violations) {
    const irs = violations.filter(v => v.caseType === "IR");
    const ntes = violations.filter(v => v.caseType === "NTE");
    return {
      totalIr: irs.length,
      pending: violations.filter(v => v.status === "pending_approval").length,
      approved: violations.filter(v => v.approvalStatus === "approved").length,
      rejected: violations.filter(v => v.approvalStatus === "rejected").length,
      generatedNte: ntes.length,
      waitingExplanation: violations.filter(v => v.status === "waiting_explanation").length,
      completed: violations.filter(v => v.status === "completed").length,
      multiViolationEmployees: (() => {
        const counts = {};
        violations.filter(v => v.caseType === "IR" && v.approvalStatus === "approved").forEach(v => {
          counts[v.employeeId] = (counts[v.employeeId] || 0) + 1;
        });
        return Object.values(counts).filter(c => c >= 2).length;
      })(),
    };
  }

  function deptChartData(violations) {
    const m = {};
    violations.forEach(v => { m[v.department || "Unknown"] = (m[v.department || "Unknown"] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }

  function categoryChartData(violations) {
    const m = {};
    violations.forEach(v => { m[v.category] = (m[v.category] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }

  function monthlyChartData(violations) {
    const m = {};
    violations.forEach(v => {
      const key = (v.violationDate || "").slice(0, 7);
      if (key) m[key] = (m[key] || 0) + 1;
    });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).slice(-6);
  }

  function topEmployeesData(violations) {
    const m = {};
    violations.filter(v => v.caseType === "IR" && v.approvalStatus === "approved").forEach(v => {
      if (!m[v.employeeId]) m[v.employeeId] = { name: v.employeeName, count: 0 };
      m[v.employeeId].count++;
    });
    return Object.values(m).sort((a, b) => b.count - a.count).slice(0, 8);
  }

  function pendingVsCompleted(violations) {
    const pending = violations.filter(v => !["completed", "rejected"].includes(v.status)).length;
    const completed = violations.filter(v => v.status === "completed").length;
    return { pending, completed };
  }

  function canCreateNte(state) { return state.session.role === "Admin"; }
  function canApproveCases(state) { return state.session.role === "Admin"; }
  function canCreateIr(state) { return !!state.session; }

  function renderNteIrTabs(state) {
    const tabs = [
      { key: "dashboard", label: "Analytics" },
      { key: "file", label: "File IR" },
      ...(canCreateNte(state) ? [{ key: "file-nte", label: "Create NTE" }] : []),
      { key: "cases", label: "All Cases" },
      { key: "history", label: "Employee History" },
    ];
    return `<div class="stockin-tabs" style="margin-bottom:16px;">
      ${tabs.map(t => `<button class="stockin-tab ${state.nteIrTab === t.key ? "active-in" : ""}" data-action="nte-set-tab" data-tab="${t.key}">${esc(t.label)}</button>`).join("")}
    </div>`;
  }

  function renderNteIrDashboard(state, violations) {
    const a = nteIrAnalytics(violations);
    const dept = deptChartData(violations);
    const cats = categoryChartData(violations);
    const monthly = monthlyChartData(violations);
    const top = topEmployeesData(violations);
    const pvc = pendingVsCompleted(violations);
    const maxDept = Math.max(1, ...dept.map(d => d[1]));
    const maxCat = Math.max(1, ...cats.map(c => c[1]));
    const maxMo = Math.max(1, ...monthly.map(m => m[1]));
    const maxTop = Math.max(1, ...top.map(t => t.count));
    const ctx = window._nteIrCtx;

    return `
      <div class="grid grid-4" style="margin-bottom:16px;">
        ${ctx.statCard(ctx.ICONS.scroll, "Total IR", a.totalIr, "Incident reports filed", "")}
        ${ctx.statCard(ctx.ICONS.alert, "Pending", a.pending, "Awaiting approval", "violet")}
        ${ctx.statCard(ctx.ICONS.check, "Approved", a.approved, "Approved cases", "ok")}
        ${ctx.statCard(ctx.ICONS.x, "Rejected", a.rejected, "Rejected cases", "danger")}
      </div>
      <div class="grid grid-4" style="margin-bottom:16px;">
        ${ctx.statCard(ctx.ICONS.tag, "Generated NTE", a.generatedNte, "Notices to explain", "accent")}
        ${ctx.statCard(ctx.ICONS.user, "Waiting Explanation", a.waitingExplanation, "Employee response pending", "violet")}
        ${ctx.statCard(ctx.ICONS.check, "Completed", a.completed, "Closed cases", "ok")}
        ${ctx.statCard(ctx.ICONS.users, "Multi-violation", a.multiViolationEmployees, "Employees with 2+ offenses", "danger")}
      </div>
      <div class="grid dash-row" style="grid-template-columns:1fr 1fr;margin-bottom:16px;">
        <div class="card">
          <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Violations by department</h2>
          ${dept.length === 0 ? `<p style="font-size:12px;color:var(--muted);">No data yet.</p>` :
            dept.map(([name, cnt]) => `
              <div style="margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${esc(name)}</span><span class="mono">${cnt}</span></div>
                <div style="height:6px;background:var(--field);border-radius:3px;"><div style="height:100%;width:${cnt/maxDept*100}%;background:var(--accent);border-radius:3px;"></div></div>
              </div>`).join("")}
        </div>
        <div class="card">
          <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Violation categories</h2>
          ${cats.length === 0 ? `<p style="font-size:12px;color:var(--muted);">No data yet.</p>` :
            cats.map(([name, cnt]) => `
              <div style="margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${esc(name)}</span><span class="mono">${cnt}</span></div>
                <div style="height:6px;background:var(--field);border-radius:3px;"><div style="height:100%;width:${cnt/maxCat*100}%;background:var(--ok);border-radius:3px;"></div></div>
              </div>`).join("")}
        </div>
      </div>
      <div class="grid dash-row" style="grid-template-columns:1.2fr 1fr;margin-bottom:16px;">
        <div class="card">
          <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Monthly violations</h2>
          <div class="chart-wrap" style="height:180px;">
            ${monthly.length === 0 ? `<p style="font-size:12px;color:var(--muted);">No data yet.</p>` :
              monthly.map(([mo, cnt]) => `
                <div class="chart-day">
                  <div class="bars"><div class="bar bar-in" style="height:${(cnt/maxMo*150)||4}px;" title="${mo}: ${cnt}"></div></div>
                  <div class="chart-daylabel">${mo.slice(5)}</div>
                </div>`).join("")}
          </div>
        </div>
        <div class="card">
          <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Top employees with violations</h2>
          ${top.length === 0 ? `<p style="font-size:12px;color:var(--muted);">No approved violations yet.</p>` :
            top.map(t => `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
                <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                  <div style="width:80px;height:6px;background:var(--field);border-radius:3px;"><div style="height:100%;width:${t.count/maxTop*100}%;background:var(--danger);border-radius:3px;"></div></div>
                  <span class="mono" style="font-size:12px;">${t.count}</span>
                </div>
              </div>`).join("")}
        </div>
      </div>
      <div class="card">
        <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Pending vs completed</h2>
        <div style="display:flex;gap:24px;align-items:flex-end;height:100px;">
          <div style="flex:1;text-align:center;">
            <div class="bar bar-out" style="width:48px;height:${(pvc.pending/Math.max(1,pvc.pending+pvc.completed)*90)||4}px;margin:0 auto;"></div>
            <div style="font-size:11px;color:var(--muted);margin-top:6px;">Pending (${pvc.pending})</div>
          </div>
          <div style="flex:1;text-align:center;">
            <div class="bar bar-in" style="width:48px;height:${(pvc.completed/Math.max(1,pvc.pending+pvc.completed)*90)||4}px;margin:0 auto;"></div>
            <div style="font-size:11px;color:var(--muted);margin-top:6px;">Completed (${pvc.completed})</div>
          </div>
        </div>
      </div>`;
  }

  function renderFileForm(state, caseType) {
    const f = state.nteIrForm || {
      employeeId: "", employeeName: "", position: "", department: DEPARTMENTS[0],
      category: VIOLATION_CATEGORIES[0], severity: "Minor",
      violationDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date()),
      violationTime: "", location: "", description: "", additionalInfo: "", remarks: "",
      policyViolated: "", explanationDeadline: "",
    };
    const userOpts = state.users.map(u =>
      `<option value="${esc(u.id)}" data-name="${esc(u.name)}" data-role="${esc(u.role)}">${esc(u.name)} (${esc(u.role)})</option>`
    ).join("");
    const isNte = caseType === "NTE";

    return `
      <div class="card">
        <h2 style="font-size:13.5px;font-weight:600;margin:0 0 14px;">${isNte ? "Create Notice to Explain (NTE)" : "File Incident Report (IR)"}</h2>
        <div class="grid grid-3" style="margin-bottom:12px;">
          <label class="field"><span class="lbl">Employee (from users)</span>
            <select id="nte-employee-pick"><option value="">— Select or type below —</option>${userOpts}</select>
          </label>
          <label class="field"><span class="lbl">Employee ID</span><input id="nte-employee-id" value="${esc(f.employeeId)}" placeholder="EMP-001" /></label>
          <label class="field"><span class="lbl">Employee name</span><input id="nte-employee-name" value="${esc(f.employeeName)}" /></label>
        </div>
        <div class="grid grid-3" style="margin-bottom:12px;">
          <label class="field"><span class="lbl">Position</span><input id="nte-position" value="${esc(f.position)}" /></label>
          <label class="field"><span class="lbl">Department</span>
            <select id="nte-department">${DEPARTMENTS.map(d => `<option ${f.department===d?"selected":""}>${esc(d)}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="lbl">Severity</span>
            <select id="nte-severity">${SEVERITIES.map(s => `<option ${f.severity===s?"selected":""}>${esc(s)}</option>`).join("")}</select>
          </label>
        </div>
        <div class="grid grid-3" style="margin-bottom:12px;">
          <label class="field"><span class="lbl">Violation category</span>
            <select id="nte-category">${VIOLATION_CATEGORIES.map(c => `<option ${f.category===c?"selected":""}>${esc(c)}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="lbl">Date</span><input id="nte-violation-date" type="date" value="${esc(f.violationDate)}" /></label>
          <label class="field"><span class="lbl">Time</span><input id="nte-violation-time" type="time" value="${esc(f.violationTime)}" /></label>
        </div>
        <label class="field" style="margin-bottom:12px;"><span class="lbl">Location</span><input id="nte-location" value="${esc(f.location)}" placeholder="Warehouse aisle, sales floor, etc." /></label>
        <label class="field" style="margin-bottom:12px;"><span class="lbl">Detailed violation description</span>
          <textarea id="nte-description" rows="3" placeholder="Describe the violation in detail…">${esc(f.description)}</textarea>
        </label>
        <label class="field" style="margin-bottom:12px;"><span class="lbl">Additional information</span>
          <textarea id="nte-additional-info" rows="5" placeholder="Observations, witnesses, sequence of events, recommendations…">${esc(f.additionalInfo)}</textarea>
        </label>
        ${isNte ? `
        <div class="grid grid-2" style="margin-bottom:12px;">
          <label class="field"><span class="lbl">Policy violated</span><input id="nte-policy" value="${esc(f.policyViolated)}" /></label>
          <label class="field"><span class="lbl">Explanation deadline</span><input id="nte-deadline" type="date" value="${esc(f.explanationDeadline)}" /></label>
        </div>` : ""}
        <label class="field" style="margin-bottom:12px;"><span class="lbl">Remarks</span>
          <textarea id="nte-remarks" rows="2">${esc(f.remarks)}</textarea>
        </label>
        <label class="field" style="margin-bottom:14px;"><span class="lbl">Supporting attachments (images, PDF, Word, Excel)</span>
          <input id="nte-attachments" type="file" multiple accept=".jpg,.jpeg,.png,.gif,.pdf,.doc,.docx,.xls,.xlsx" />
        </label>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn btn-ghost" data-action="nte-reset-form">Clear</button>
          <button class="btn btn-primary" data-action="nte-submit-form" data-case-type="${caseType}">${isNte ? "Create NTE" : "Submit Incident Report"}</button>
        </div>
      </div>`;
  }

  function renderFilters(state) {
    const f = state.nteIrFilters;
    const reporters = [...new Set(window._nteIrCtx.state.violations.map(v => v.reporterName))].sort();
    return `
      <div class="card" style="margin-bottom:16px;">
        <div class="grid grid-3" style="margin-bottom:10px;">
          <label class="field"><span class="lbl">Search</span><input id="nte-filter-q" value="${esc(f.q)}" placeholder="Case #, employee, description…" /></label>
          <label class="field"><span class="lbl">Department</span>
            <select id="nte-filter-dept"><option value="all">All</option>${DEPARTMENTS.map(d => `<option value="${esc(d)}" ${f.department===d?"selected":""}>${esc(d)}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="lbl">Category</span>
            <select id="nte-filter-cat"><option value="all">All</option>${VIOLATION_CATEGORIES.map(c => `<option value="${esc(c)}" ${f.category===c?"selected":""}>${esc(c)}</option>`).join("")}</select>
          </label>
        </div>
        <div class="grid grid-4">
          <label class="field"><span class="lbl">Status</span>
            <select id="nte-filter-status"><option value="all">All</option>
              ${["pending_approval","approved","rejected","waiting_explanation","explanation_uploaded","sanction_uploaded","completed"].map(s =>
                `<option value="${s}" ${f.status===s?"selected":""}>${statusLabel(s)}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span class="lbl">Severity</span>
            <select id="nte-filter-severity"><option value="all">All</option>${SEVERITIES.map(s => `<option value="${s}" ${f.severity===s?"selected":""}>${esc(s)}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="lbl">Reporter</span>
            <select id="nte-filter-reporter"><option value="all">All</option>${reporters.map(r => `<option value="${esc(r)}" ${f.reporter===r?"selected":""}>${esc(r)}</option>`).join("")}</select>
          </label>
          <label class="field"><span class="lbl">Date range</span>
            <div style="display:flex;gap:6px;"><input id="nte-filter-from" type="date" value="${esc(f.dateFrom)}" style="flex:1;" /><input id="nte-filter-to" type="date" value="${esc(f.dateTo)}" style="flex:1;" /></div>
          </label>
        </div>
        <div class="toolbar" style="margin-top:12px;">
          <button class="btn btn-ghost btn-sm" data-action="nte-export-csv">Export CSV</button>
          <button class="btn btn-ghost btn-sm" data-action="nte-export-pdf">Export PDF</button>
        </div>
      </div>`;
  }

  function renderWorkflowTimeline(c) {
    const hist = c.workflowHistory || [];
    if (hist.length === 0) return `<p style="font-size:12px;color:var(--muted);">No workflow events yet.</p>`;
    return `<div class="nte-timeline">
      ${hist.map(h => `
        <div class="nte-timeline-item">
          <div class="nte-timeline-dot"></div>
          <div>
            <div style="font-size:13px;font-weight:500;">${esc(h.action)}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(h.by)} (${esc(h.role)}) · ${esc(h.timestamp)}</div>
            ${h.note ? `<div style="font-size:12px;color:var(--nav-text);margin-top:2px;">${esc(h.note)}</div>` : ""}
          </div>
        </div>`).join("")}
    </div>`;
  }

  function renderCaseDetail(c, state) {
    const admin = canApproveCases(state);
    const isOwner = c.reporterId === state.session.id;
    const isSubject = c.employeeId === state.session.id;
    const isNte = c.caseType === "NTE";
    const canClose = admin && isNte && c.explanationPdf && c.sanctionPdf && c.status !== "completed" && c.status !== "rejected";
    const needsExplanation = isNte && ["waiting_explanation", "explanation_uploaded", "sanction_uploaded", "nte_generated"].includes(c.status);
    const ctx = window._nteIrCtx;

    return `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="mono" style="font-size:15px;font-weight:600;">${esc(c.id)}</span>
              <span class="tag tag-accent">${esc(c.caseType)}</span>
              ${statusTag(c.status)} ${severityTag(c.severity)}
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;">${esc(c.employeeName)} · ${esc(c.department)} · Filed ${esc(c.createdAt ? c.createdAt.slice(0,10) : "")}</div>
          </div>
          <div class="toolbar">
            <button class="btn btn-ghost btn-sm" data-action="nte-back-cases">← Back</button>
            <button class="btn btn-ghost btn-sm" data-action="nte-gen-pdf" data-id="${esc(c.id)}">PDF</button>
            ${admin ? `<button class="btn btn-danger btn-sm" data-action="nte-delete-case" data-id="${esc(c.id)}">Delete</button>` : ""}
          </div>
        </div>
        <div class="grid grid-2" style="margin-bottom:14px;">
          <div><span class="stat-label">Employee</span><div style="font-size:13px;margin-top:4px;">${esc(c.employeeName)} (${esc(c.employeeId)})</div></div>
          <div><span class="stat-label">Position</span><div style="font-size:13px;margin-top:4px;">${esc(c.position) || "—"}</div></div>
          <div><span class="stat-label">Reporter</span><div style="font-size:13px;margin-top:4px;">${esc(c.reporterName)} (${esc(c.reporterRole)})</div></div>
          <div><span class="stat-label">Approved violations</span><div style="font-size:13px;margin-top:4px;" class="mono">${approvedIrCount(c.employeeId, state.violations)}</div></div>
        </div>
        <div style="margin-bottom:12px;"><span class="stat-label">Category</span><div style="margin-top:4px;">${esc(c.category)} · ${esc(c.violationDate)} ${esc(c.violationTime)} · ${esc(c.location)}</div></div>
        <div style="margin-bottom:12px;"><span class="stat-label">Description</span><div style="font-size:13px;margin-top:4px;white-space:pre-wrap;">${esc(c.description)}</div></div>
        ${c.additionalInfo ? `<div style="margin-bottom:12px;"><span class="stat-label">Additional information</span><div style="font-size:13px;margin-top:4px;white-space:pre-wrap;">${esc(c.additionalInfo)}</div></div>` : ""}
        ${c.remarks ? `<div style="margin-bottom:12px;"><span class="stat-label">Remarks</span><div style="font-size:13px;margin-top:4px;">${esc(c.remarks)}</div></div>` : ""}
        ${c.attachments && c.attachments.length ? `
          <div style="margin-bottom:12px;"><span class="stat-label">Attachments</span>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
              ${c.attachments.map(a => `<a href="${esc(a.url)}" target="_blank" class="chip" style="text-decoration:none;">${esc(a.name)}</a>`).join("")}
            </div>
          </div>` : ""}
        ${c.status === "pending_approval" && admin ? `
          <div class="toolbar" style="margin-bottom:14px;">
            <button class="btn btn-primary btn-sm" data-action="nte-approve" data-id="${esc(c.id)}">Approve</button>
            <button class="btn btn-danger btn-sm" data-action="nte-reject" data-id="${esc(c.id)}">Reject</button>
          </div>` : ""}
        ${needsExplanation && (isSubject || admin) && !c.explanationPdf ? `
          <div class="card" style="background:var(--field);margin-bottom:14px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Upload employee explanation (PDF required)</div>
            <input id="nte-explanation-file" type="file" accept=".pdf,application/pdf" />
            <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-action="nte-upload-explanation" data-id="${esc(c.id)}">Upload explanation</button>
          </div>` : ""}
        ${c.explanationPdf ? `<div style="margin-bottom:12px;font-size:12px;color:var(--ok);">✓ Explanation PDF uploaded</div>` : ""}
        ${admin && isNte && c.status !== "rejected" ? `
          <div class="card" style="background:var(--field);margin-bottom:14px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Upload sanction report (PDF required)</div>
            <input id="nte-sanction-file" type="file" accept=".pdf" ${c.sanctionPdf ? "disabled" : ""} />
            ${c.sanctionPdf ? `<div style="font-size:12px;color:var(--ok);margin-top:6px;">✓ Sanction report uploaded</div>` : ""}
            ${!c.sanctionPdf ? `<button class="btn btn-primary btn-sm" style="margin-top:8px;" data-action="nte-upload-sanction" data-id="${esc(c.id)}">Upload sanction</button>` : ""}
          </div>` : ""}
        ${(isOwner || admin) && c.status === "pending_approval" ? `
          <div class="card" style="background:var(--field);margin-bottom:14px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Add supporting evidence</div>
            <input id="nte-add-attachment" type="file" multiple accept=".jpg,.jpeg,.png,.gif,.pdf,.doc,.docx,.xls,.xlsx" />
            <button class="btn btn-ghost btn-sm" style="margin-top:8px;" data-action="nte-add-attachment" data-id="${esc(c.id)}">Upload files</button>
          </div>` : ""}
        ${isNte ? `
        <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
          <button class="btn btn-primary" data-action="nte-close-case" data-id="${esc(c.id)}" ${canClose ? "" : "disabled title=\"Requires both explanation PDF and sanction PDF\""}>Close Case</button>
        </div>` : ""}
        <h3 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Workflow timeline</h3>
        ${renderWorkflowTimeline(c)}
      </div>`;
  }

  function renderCasesList(state, list) {
    if (state.nteIrSelectedId) {
      const c = state.violations.find(v => v.id === state.nteIrSelectedId);
      if (c) return renderCaseDetail(c, state);
    }
    return `
      ${renderFilters(state)}
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Case #</th><th>Type</th><th>Employee</th><th>Category</th><th>Severity</th><th>Status</th><th>Reporter</th><th>Date</th><th></th></tr></thead>
            <tbody>
              ${list.length === 0 ? `<tr><td colspan="9" style="text-align:center;color:var(--dim);padding:24px;">No cases match your filters.</td></tr>` :
                list.slice(0, 100).map(c => `
                  <tr>
                    <td class="mono" style="font-size:12px;">${esc(c.id)}</td>
                    <td><span class="tag">${esc(c.caseType)}</span></td>
                    <td>${esc(c.employeeName)}</td>
                    <td style="font-size:12px;">${esc(c.category)}</td>
                    <td>${severityTag(c.severity)}</td>
                    <td>${statusTag(c.status)}</td>
                    <td style="font-size:12px;color:var(--muted);">${esc(c.reporterName)}</td>
                    <td style="font-size:11px;color:var(--dim);">${esc(c.violationDate)}</td>
                    <td><button class="btn btn-ghost btn-sm" data-action="nte-view-case" data-id="${esc(c.id)}">View</button></td>
                  </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function renderEmployeeHistory(state) {
    const empId = state.nteIrHistoryEmployee;
    const ctx = window._nteIrCtx;
    const userOpts = state.users.map(u => `<option value="${esc(u.id)}" ${empId===u.id?"selected":""}>${esc(u.name)}</option>`).join("");
    if (!empId) {
      return `<div class="card"><label class="field"><span class="lbl">Select employee</span>
        <select id="nte-history-employee"><option value="">— Choose employee —</option>${userOpts}</select>
      </label></div>`;
    }
    const cases = state.violations.filter(v => v.employeeId === empId);
    const approved = approvedIrCount(empId, state.violations);
    const openCases = cases.filter(c => !["completed", "rejected"].includes(c.status)).length;
    const completed = cases.filter(c => c.status === "completed").length;
    const nte = cases.find(c => c.caseType === "NTE" && c.status !== "completed");
    const timeline = cases.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    return `
      <div class="card" style="margin-bottom:16px;">
        <label class="field"><span class="lbl">Employee</span>
          <select id="nte-history-employee"><option value="">— Choose employee —</option>${userOpts}</select>
        </label>
      </div>
      <div class="grid grid-4" style="margin-bottom:16px;">
        ${ctx.statCard(ctx.ICONS.alert, "Approved violations", approved, "Total approved IR count", approved >= 3 ? "danger" : "")}
        ${ctx.statCard(ctx.ICONS.scroll, "Open cases", openCases, "Not yet completed", "violet")}
        ${ctx.statCard(ctx.ICONS.check, "Completed", completed, "Closed cases", "ok")}
        ${ctx.statCard(ctx.ICONS.tag, "NTE status", nte ? statusLabel(nte.status) : "None", nte ? nte.id : "No active NTE", nte ? "accent" : "")}
      </div>
      <div class="card">
        <h2 style="font-size:13.5px;font-weight:600;margin:0 0 10px;">Violation timeline</h2>
        ${timeline.length === 0 ? `<p style="font-size:12px;color:var(--muted);">No violation records for this employee.</p>` :
          timeline.map(c => `
            <div style="border-bottom:1px solid var(--line-2);padding:12px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div>
                <span class="mono" style="font-size:12px;font-weight:600;">${esc(c.id)}</span> ${statusTag(c.status)}
                <div style="font-size:12px;color:var(--muted);margin-top:4px;">${esc(c.category)} · ${esc(c.violationDate)} · ${esc(c.severity)}</div>
              </div>
              <button class="btn btn-ghost btn-sm" data-action="nte-view-case" data-id="${esc(c.id)}">View</button>
            </div>`).join("")}
      </div>`;
  }

  function renderNteIr(state) {
    const violations = visibleViolations(state);
    let body;
    switch (state.nteIrTab) {
      case "dashboard": body = renderNteIrDashboard(state, violations); break;
      case "file": body = renderFileForm(state, "IR"); break;
      case "file-nte": body = canCreateNte(state) ? renderFileForm(state, "NTE") : renderNteIrDashboard(state, violations); break;
      case "cases": body = renderCasesList(state, filteredViolations(state)); break;
      case "history": body = renderEmployeeHistory(state); break;
      default: body = renderNteIrDashboard(state, violations);
    }
    return `
      <div style="margin-bottom:20px;">
        <h1 class="page-title">NTE / IR — Violation Management</h1>
        <p class="page-sub">Incident reports, notices to explain, approval workflow, and employee violation tracking.</p>
      </div>
      ${renderNteIrTabs(state)}
      ${body}`;
  }

  async function uploadFiles(files, caseId) {
    const ctx = window._nteIrCtx;
    const bucket = storageBucket(ctx);
    const results = [];
    for (const file of files) {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `${caseId}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
      if (bucket) {
        const { error } = await bucket.upload(path, file, { upsert: false });
        if (!error) {
          const { data: urlData } = bucket.getPublicUrl(path);
          results.push({ name: file.name, url: urlData.publicUrl, type: file.type, uploadedAt: ctx.fmt(0) });
          continue;
        }
        if (file.size >= 500000) throw new Error(error.message);
      } else if (file.size >= 500000) {
        throw new Error("Storage is not configured — file is too large to embed inline");
      }
      results.push({ name: file.name, url: await fileToDataUrl(file), type: file.type, uploadedAt: ctx.fmt(0) });
    }
    return results;
  }

  async function uploadSinglePdf(file, caseId, kind) {
    const ctx = window._nteIrCtx;
    const bucket = storageBucket(ctx);
    const path = `${caseId}/${kind}_${Date.now()}.pdf`;
    if (bucket) {
      const { error } = await bucket.upload(path, file, { contentType: "application/pdf" });
      if (!error) {
        const { data: urlData } = bucket.getPublicUrl(path);
        return urlData.publicUrl;
      }
      if (file.size >= 800000) throw new Error(error.message);
    } else if (file.size >= 800000) {
      throw new Error("Storage is not configured — PDF is too large to embed inline");
    }
    return fileToDataUrl(file);
  }

  function readFormFromDom(caseType) {
    return {
      employeeId: document.getElementById("nte-employee-id").value.trim(),
      employeeName: document.getElementById("nte-employee-name").value.trim(),
      position: document.getElementById("nte-position").value.trim(),
      department: document.getElementById("nte-department").value,
      category: document.getElementById("nte-category").value,
      severity: document.getElementById("nte-severity").value,
      violationDate: document.getElementById("nte-violation-date").value,
      violationTime: document.getElementById("nte-violation-time").value,
      location: document.getElementById("nte-location").value.trim(),
      description: document.getElementById("nte-description").value.trim(),
      additionalInfo: document.getElementById("nte-additional-info").value.trim(),
      remarks: document.getElementById("nte-remarks").value.trim(),
      policyViolated: caseType === "NTE" ? document.getElementById("nte-policy").value.trim() : "",
      explanationDeadline: caseType === "NTE" ? document.getElementById("nte-deadline").value : "",
    };
  }

  async function submitCase(caseType) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render, fmt } = ctx;
    if (caseType === "NTE" && !canCreateNte(state)) return showToast("Only Admins can create NTEs", "danger");
    if (caseType === "IR" && !canCreateIr(state)) return showToast("Sign in required", "danger");

    const f = readFormFromDom(caseType);
    if (!f.employeeId || !f.employeeName) return showToast("Employee ID and name are required", "danger");
    if (!f.description) return showToast("Violation description is required", "danger");
    if (!f.violationDate) return showToast("Violation date is required", "danger");

    const prefix = caseType === "NTE" ? "NTE" : "IR";
    const id = generateCaseNumber(prefix, state.violations);
    const count = approvedIrCount(f.employeeId, state.violations);

    const c = {
      id, caseType, ...f,
      reporterId: state.session.id, reporterName: state.session.name, reporterRole: state.session.role,
      attachments: [], status: caseType === "NTE" ? "waiting_explanation" : "pending_approval",
      approvalStatus: caseType === "NTE" ? "approved" : "pending",
      violationCount: count,
      explanationPdf: "", sanctionPdf: "", relatedIrIds: [], parentCaseId: "",
      workflowHistory: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    addWorkflow(c, caseType === "NTE" ? "NTE Created" : "Incident Report Filed", f.description.slice(0, 120));
    if (caseType === "NTE") addWorkflow(c, "Waiting for Employee Explanation", "");

    const fileInput = document.getElementById("nte-attachments");
    if (fileInput && fileInput.files && fileInput.files.length) {
      try {
        c.attachments = await uploadFiles([...fileInput.files], id);
        addWorkflow(c, "Attachments uploaded", `${c.attachments.length} file(s)`);
      } catch (e) { showToast("Attachment upload failed: " + e.message, "danger"); return; }
    }

    const { error } = await sb.from("violation_cases").insert(toDbRow(c));
    if (error) { showToast(error.message, "danger"); return; }

    state.violations.unshift(c);
    state.nteIrForm = null;
    state.nteIrTab = "cases";
    state.nteIrSelectedId = id;
    showToast(`${caseType} ${id} submitted`, "ok");
    render();
  }

  async function autoGenerateNte(irCase) {
    const ctx = window._nteIrCtx;
    const { state, sb, fmt } = ctx;
    const approved = approvedIrCount(irCase.employeeId, state.violations);
    if (approved < 3) return null;
    const existingOpen = state.violations.find(v => v.caseType === "NTE" && v.employeeId === irCase.employeeId && !["completed", "rejected"].includes(v.status));
    if (existingOpen) return existingOpen;

    const priorIrs = state.violations.filter(v => v.caseType === "IR" && v.employeeId === irCase.employeeId && v.approvalStatus === "approved").map(v => v.id);
    const deadline = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(Date.now() + 7 * 86400000));
    const id = generateCaseNumber("NTE", state.violations);
    const nte = {
      id, caseType: "NTE",
      employeeId: irCase.employeeId, employeeName: irCase.employeeName, position: irCase.position, department: irCase.department,
      reporterId: state.session.id, reporterName: state.session.name, reporterRole: state.session.role,
      category: irCase.category, severity: "Major",
      violationDate: irCase.violationDate, violationTime: irCase.violationTime, location: irCase.location,
      description: `Auto-generated Notice to Explain following the employee's 3rd approved violation (${irCase.id}).`,
      additionalInfo: `Previous approved IR cases: ${priorIrs.join(", ")}. Employee has reached the three-strike threshold per company policy.`,
      remarks: "System-generated NTE — requires employee explanation and admin sanction before closure.",
      attachments: [], status: "waiting_explanation", approvalStatus: "approved",
      violationCount: approved, explanationPdf: "", sanctionPdf: "",
      policyViolated: "Company disciplinary policy — three-strike rule",
      explanationDeadline: deadline,
      relatedIrIds: priorIrs, parentCaseId: irCase.id,
      workflowHistory: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    addWorkflow(nte, "NTE Auto-Generated", `Triggered by approval of ${irCase.id} (3rd offense)`);
    addWorkflow(nte, "Waiting for Employee Explanation", `Deadline: ${deadline}`);

    const { error } = await sb.from("violation_cases").insert(toDbRow(nte));
    if (error) { console.error("NTE auto-gen failed:", error); return null; }
    state.violations.unshift(nte);
    return nte;
  }

  async function approveCase(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    if (!canApproveCases(state)) return showToast("Only Admins can approve cases", "danger");
    const c = state.violations.find(v => v.id === id);
    if (!c || c.approvalStatus !== "pending") return;

    const approved = approvedIrCount(c.employeeId, state.violations) + 1;
    c.approvalStatus = "approved";
    c.violationCount = approved;
    if (c.caseType === "IR") {
      c.status = approved >= 3 ? "approved" : "completed";
      addWorkflow(c, "Approved", `Violation count now ${approved}`);
      if (approved < 3) addWorkflow(c, "Completed", "IR closed — under 3-strike threshold");
    }
    const { error } = await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
    if (error) { showToast(error.message, "danger"); return; }

    if (c.caseType === "IR" && approved >= 3) {
      const nte = await autoGenerateNte(c);
      if (nte) {
        c.status = "nte_generated";
        addWorkflow(c, "NTE Generated", nte.id);
        await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
        showToast(`Approved — NTE ${nte.id} auto-generated (3rd offense)`, "ok");
      } else showToast("Approved", "ok");
    } else showToast(c.status === "completed" ? "Approved and completed" : "Approved", "ok");
    render();
  }

  async function rejectCase(id, reason) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    if (!canApproveCases(state)) return;
    const c = state.violations.find(v => v.id === id);
    if (!c) return;
    c.approvalStatus = "rejected";
    c.status = "rejected";
    addWorkflow(c, "Rejected", reason || "");
    const { error } = await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
    if (error) { showToast(error.message, "danger"); return; }
    showToast("Case rejected", "ok");
    render();
  }

  async function uploadExplanation(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    const c = state.violations.find(v => v.id === id);
    const input = document.getElementById("nte-explanation-file");
    if (!c || c.caseType !== "NTE") return;
    if (!input || !input.files || !input.files[0]) return showToast("Select a PDF file", "danger");
    if (!isPdfFile(input.files[0])) return showToast("Explanation must be a PDF", "danger");
    try {
      c.explanationPdf = await uploadSinglePdf(input.files[0], id, "explanation");
      c.status = "explanation_uploaded";
      addWorkflow(c, "Explanation Uploaded", input.files[0].name);
      await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
      showToast("Explanation uploaded", "ok");
      render();
    } catch (e) { showToast(e.message, "danger"); }
  }

  async function uploadSanction(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    if (!canApproveCases(state)) return showToast("Only Admins can upload sanction reports", "danger");
    const c = state.violations.find(v => v.id === id);
    const input = document.getElementById("nte-sanction-file");
    if (!c || !input || !input.files || !input.files[0]) return showToast("Select a PDF file", "danger");
    if (!isPdfFile(input.files[0])) return showToast("Sanction report must be a PDF", "danger");
    try {
      c.sanctionPdf = await uploadSinglePdf(input.files[0], id, "sanction");
      c.status = "sanction_uploaded";
      addWorkflow(c, "Sanction Report Uploaded", input.files[0].name);
      await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
      showToast("Sanction report uploaded", "ok");
      render();
    } catch (e) { showToast(e.message, "danger"); }
  }

  async function closeCase(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    if (!canApproveCases(state)) return;
    const c = state.violations.find(v => v.id === id);
    if (!c || c.caseType !== "NTE") return;
    if (!c.explanationPdf || !c.sanctionPdf) {
      return showToast("Both explanation PDF and sanction PDF are required before closing", "danger");
    }
    c.status = "completed";
    addWorkflow(c, "Completed", "Case closed by Admin");
    const { error } = await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
    if (error) { showToast(error.message, "danger"); return; }
    showToast("Case closed", "ok");
    render();
  }

  async function deleteCase(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    if (!canApproveCases(state)) return;
    const { error } = await sb.from("violation_cases").delete().eq("id", id);
    if (error) { showToast(error.message, "danger"); return; }
    state.violations = state.violations.filter(v => v.id !== id);
    state.nteIrSelectedId = null;
    showToast("Case deleted", "ok");
    render();
  }

  async function addAttachmentToCase(id) {
    const ctx = window._nteIrCtx;
    const { state, sb, showToast, render } = ctx;
    const c = state.violations.find(v => v.id === id);
    const input = document.getElementById("nte-add-attachment");
    if (!c || !input || !input.files || !input.files.length) return showToast("Select files to upload", "danger");
    try {
      const uploaded = await uploadFiles([...input.files], id);
      c.attachments = [...(c.attachments || []), ...uploaded];
      addWorkflow(c, "Additional evidence uploaded", `${uploaded.length} file(s)`);
      await sb.from("violation_cases").update(toDbRow(c)).eq("id", id);
      showToast("Files attached", "ok");
      render();
    } catch (e) { showToast(e.message, "danger"); }
  }

  async function ensureAutoTable() {
    const ctx = window._nteIrCtx;
    await ctx.loadScriptOnce(ctx.JSPDF_URL);
    await ctx.loadScriptOnce(JSPDF_AUTOTABLE_URL);
  }

  async function generateCasePdf(id) {
    const ctx = window._nteIrCtx;
    const { state, showToast } = ctx;
    const c = state.violations.find(v => v.id === id);
    if (!c) return;
    await ensureAutoTable();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const isNte = c.caseType === "NTE";
    doc.setFontSize(16);
    doc.text(isNte ? "NOTICE TO EXPLAIN" : "INCIDENT REPORT", 14, 18);
    doc.setFontSize(10);
    doc.text(`Case Number: ${c.id}`, 14, 28);
    doc.text(`Date Generated: ${ctx.fmt(0)}`, 14, 34);

    doc.autoTable({
      startY: 42,
      head: [["Field", "Value"]],
      body: [
        ["Employee ID", c.employeeId], ["Employee Name", c.employeeName], ["Position", c.position || "—"],
        ["Department", c.department], ["Reporter", `${c.reporterName} (${c.reporterRole})`],
        ["Category", c.category], ["Severity", c.severity],
        ["Date / Time", `${c.violationDate} ${c.violationTime}`], ["Location", c.location || "—"],
        ["Status", statusLabel(c.status)], ["Approved Violations", String(approvedIrCount(c.employeeId, state.violations))],
      ],
      styles: { fontSize: 9 }, headStyles: { fillColor: [255, 138, 61] },
    });

    let y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(11);
    doc.text("Violation Description", 14, y);
    y += 6;
    doc.setFontSize(9);
    doc.text(doc.splitTextToSize(c.description, 180), 14, y);
    y += doc.splitTextToSize(c.description, 180).length * 5 + 6;

    if (c.additionalInfo) {
      doc.setFontSize(11);
      doc.text("Additional Information", 14, y);
      y += 6;
      doc.setFontSize(9);
      doc.text(doc.splitTextToSize(c.additionalInfo, 180), 14, y);
      y += doc.splitTextToSize(c.additionalInfo, 180).length * 5 + 6;
    }

    if (isNte) {
      const relatedIds = c.relatedIrIds || [];
      const prior = state.violations.filter(v => v.caseType === "IR" && relatedIds.includes(v.id));
      doc.setFontSize(11);
      doc.text("Previous Offenses", 14, y);
      y += 6;
      if (prior.length) {
        doc.autoTable({
          startY: y,
          head: [["Case #", "Date", "Category", "Severity"]],
          body: prior.map(p => [p.id, p.violationDate, p.category, p.severity]),
          styles: { fontSize: 8 },
        });
        y = doc.lastAutoTable.finalY + 8;
      }
      doc.setFontSize(10);
      doc.text(`Policy Violated: ${c.policyViolated || "Company disciplinary policy"}`, 14, y);
      y += 8;
      doc.text(`Explanation Deadline: ${c.explanationDeadline || "—"}`, 14, y);
      y += 16;
      doc.text("Employee Signature: _________________________    Date: __________", 14, y);
      y += 10;
      doc.text("HR / Admin Signature: _______________________    Date: __________", 14, y);
    }

    doc.save(`${c.id}.pdf`);
    showToast("PDF downloaded", "ok");
  }

  function exportCsv(state) {
    const list = filteredViolations(state);
    const headers = ["Case Number","Type","Employee ID","Employee Name","Department","Category","Severity","Status","Reporter","Date","Description"];
    const rows = list.map(c => [c.id, c.caseType, c.employeeId, c.employeeName, c.department, c.category, c.severity, statusLabel(c.status), c.reporterName, c.violationDate, c.description.replace(/"/g, '""')]);
    const csv = [headers.join(","), ...rows.map(r => r.map(v => `"${v}"`).join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `violations_${todayKey()}.csv`;
    a.click();
    window._nteIrCtx.showToast("CSV exported", "ok");
  }

  async function exportPdfReport(state) {
    const ctx = window._nteIrCtx;
    await ensureAutoTable();
    const list = filteredViolations(state);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text("DEPOT/OS — Violation Cases Report", 14, 16);
    doc.setFontSize(9);
    doc.text(`Generated: ${ctx.fmt(0)} · ${list.length} record(s)`, 14, 22);
    doc.autoTable({
      startY: 28,
      head: [["Case #","Type","Employee","Dept","Category","Severity","Status","Reporter","Date"]],
      body: list.map(c => [c.id, c.caseType, c.employeeName, c.department, c.category, c.severity, statusLabel(c.status), c.reporterName, c.violationDate]),
      styles: { fontSize: 7 }, headStyles: { fillColor: [255, 138, 61] },
    });
    doc.save(`violations_report_${todayKey()}.pdf`);
    ctx.showToast("PDF report exported", "ok");
  }

  function syncFiltersFromDom(state) {
    const g = (id) => document.getElementById(id);
    state.nteIrFilters = {
      q: g("nte-filter-q")?.value || "",
      department: g("nte-filter-dept")?.value || "all",
      category: g("nte-filter-cat")?.value || "all",
      status: g("nte-filter-status")?.value || "all",
      severity: g("nte-filter-severity")?.value || "all",
      reporter: g("nte-filter-reporter")?.value || "all",
      dateFrom: g("nte-filter-from")?.value || "",
      dateTo: g("nte-filter-to")?.value || "",
    };
  }

  function wireHandlers(app) {
    if (app._nteIrWired) return;
    app._nteIrWired = true;
    app.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-action^='nte-']");
      if (!el) return;
      const ctx = window._nteIrCtx;
      if (!ctx) return;
      const { state, render, askConfirm } = ctx;
      const action = el.dataset.action;

      if (action === "nte-set-tab") { state.nteIrTab = el.dataset.tab; state.nteIrSelectedId = null; render(); }
      else if (action === "nte-reset-form") { state.nteIrForm = null; render(); }
      else if (action === "nte-submit-form") await submitCase(el.dataset.caseType);
      else if (action === "nte-view-case") { state.nteIrSelectedId = el.dataset.id; state.nteIrTab = "cases"; render(); }
      else if (action === "nte-back-cases") { state.nteIrSelectedId = null; render(); }
      else if (action === "nte-approve") await approveCase(el.dataset.id);
      else if (action === "nte-reject") {
        const reason = prompt("Reason for rejection (optional):");
        if (reason === null) return;
        await rejectCase(el.dataset.id, reason.trim());
      }
      else if (action === "nte-upload-explanation") await uploadExplanation(el.dataset.id);
      else if (action === "nte-upload-sanction") await uploadSanction(el.dataset.id);
      else if (action === "nte-close-case") await closeCase(el.dataset.id);
      else if (action === "nte-delete-case") {
        askConfirm("Delete case?", `Permanently delete ${el.dataset.id}?`, "nte-delete-case", el.dataset.id, "Delete");
      }
      else if (action === "nte-add-attachment") await addAttachmentToCase(el.dataset.id);
      else if (action === "nte-gen-pdf") await generateCasePdf(el.dataset.id);
      else if (action === "nte-export-csv") { syncFiltersFromDom(state); exportCsv(state); }
      else if (action === "nte-export-pdf") { syncFiltersFromDom(state); await exportPdfReport(state); }
    }, true);

    app.addEventListener("change", (e) => {
      const ctx = window._nteIrCtx;
      if (!ctx) return;
      const { state, render } = ctx;
      if (e.target.id === "nte-employee-pick") {
        const opt = e.target.selectedOptions[0];
        if (opt && opt.value) {
          document.getElementById("nte-employee-id").value = opt.value;
          document.getElementById("nte-employee-name").value = opt.dataset.name || "";
          document.getElementById("nte-position").value = opt.dataset.role || "";
        }
      }
      if (e.target.id === "nte-history-employee") {
        state.nteIrHistoryEmployee = e.target.value || null;
        render();
      }
      if (e.target.id && e.target.id.startsWith("nte-filter-")) {
        syncFiltersFromDom(state);
        render();
      }
    });

    app.addEventListener("input", (e) => {
      if (e.target.id === "nte-filter-q") {
        const ctx = window._nteIrCtx;
        if (!ctx) return;
        clearTimeout(ctx._nteFilterDebounce);
        ctx._nteFilterDebounce = setTimeout(() => {
          syncFiltersFromDom(ctx.state);
          ctx.render();
        }, 200);
      }
    });
  }

  async function loadViolations(sb, state) {
    try {
      const { data, error } = await sb.from("violation_cases").select("*").order("created_at", { ascending: false }).limit(2000);
      if (error) {
        console.warn("violation_cases load:", error.message);
        state.violations = [];
        return;
      }
      state.violations = (data || []).map(mapViolationRow);
    } catch (e) {
      state.violations = [];
    }
  }

  async function runConfirmedAction(type, payload, state) {
    if (type === "nte-delete-case") await deleteCase(payload);
  }

  window.NteIr = {
    defaultNteIrState,
    mapViolationRow,
    renderNteIr,
    loadViolations,
    wireHandlers,
    runConfirmedAction,
    integrate(ctx) {
      window._nteIrCtx = { ...ctx, JSPDF_URL: ctx.JSPDF_URL || "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", _nteFilterDebounce: null };
      Object.assign(ctx.state, defaultNteIrState(), { violations: ctx.state.violations || [] });
    },
  };
})();
