/**
 * Classroom Admin — backend (Google Apps Script)
 *
 * Implements every action the frontend (index.html) calls:
 *   GET  ?action=getOUs
 *   GET  ?action=getUsersByOU&orgUnitPath=...
 *   GET  ?action=getCourses&refresh=0|1
 *   GET  ?action=getCourseMembers&courseId=...
 *   POST { action: 'addTeacher',    courseId, teacherEmail }
 *   POST { action: 'removeTeacher', courseId, teacherEmail }
 *   POST { action: 'addStudent',    courseId, studentEmail }
 *   POST { action: 'removeStudent', courseId, studentEmail }
 *
 * REQUIRED SETUP — see README.md for full step-by-step instructions.
 *   1. This script must be run by a super admin (or an admin with the
 *      Classroom + Admin Directory admin privileges) — deploy as "Execute as: Me".
 *   2. Enable the Advanced Google Services "Admin SDK" and "Google Classroom API"
 *      in the Apps Script editor (Services > + ).
 *   3. Enable the matching APIs in the linked Cloud project
 *      (Admin SDK API, Google Classroom API).
 *   4. Deploy > New deployment > Web app > Execute as "Me", Access "Anyone
 *      within <domain>" (recommended) or "Anyone".
 *   5. Paste the deployment URL into API_URL at the top of index.html's <script>.
 */

// Cache domain-wide course scans for this many seconds, since a full
// courses.list() sweep can be slow on large domains. Force a fresh scan
// with ?refresh=1 (the UI's refresh button does this).
const COURSE_CACHE_SECONDS = 300;
const COURSE_CACHE_KEY = 'classroom_admin_all_courses_v1';

function doGet(e) {
  try {
    const action = e.parameter.action;
    let result;
    switch (action) {
      case 'getOUs':
        result = getOUs();
        break;
      case 'getUsersByOU':
        result = getUsersByOU(e.parameter.orgUnitPath);
        break;
      case 'getCourses':
        result = getCourses(e.parameter.refresh === '1');
        break;
      case 'getCourseMembers':
        result = getCourseMembers(e.parameter.courseId);
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    return jsonOut(Object.assign({ success: true }, result));
  } catch (err) {
    return jsonOut({ success: false, error: err && err.message ? err.message : String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;
    switch (action) {
      case 'addTeacher':
        result = addTeacher(body.courseId, body.teacherEmail);
        break;
      case 'removeTeacher':
        result = removeTeacher(body.courseId, body.teacherEmail);
        break;
      case 'addStudent':
        result = addStudent(body.courseId, body.studentEmail);
        break;
      case 'removeStudent':
        result = removeStudent(body.courseId, body.studentEmail);
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    return jsonOut(Object.assign({ success: true }, result));
  } catch (err) {
    return jsonOut({ success: false, error: err && err.message ? err.message : String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   ORGANIZATIONAL UNITS
   ============================================================ */
function getOUs() {
  const resp = AdminDirectory.Orgunits.list('my_customer', { type: 'all' });
  const ous = (resp.organizationUnits || []).map(function (ou) {
    return { name: ou.name, orgUnitPath: ou.orgUnitPath };
  });
  // Always include the root OU as an explicit option.
  if (!ous.some(function (ou) { return ou.orgUnitPath === '/'; })) {
    ous.unshift({ name: '/ (root)', orgUnitPath: '/' });
  }
  ous.sort(function (a, b) { return a.orgUnitPath.localeCompare(b.orgUnitPath); });
  return { ous: ous };
}

/* ============================================================
   USERS BY OU
   ============================================================ */
function getUsersByOU(orgUnitPath) {
  if (!orgUnitPath) throw new Error('orgUnitPath is required');
  const users = [];
  let pageToken;
  do {
    const resp = AdminDirectory.Users.list({
      customer: 'my_customer',
      orgUnitPath: orgUnitPath,
      // includes suspended users too, so admins can see the full roster
      maxResults: 500,
      pageToken: pageToken,
      orderBy: 'givenName',
    });
    (resp.users || []).forEach(function (u) {
      users.push({
        primaryEmail: u.primaryEmail,
        name: { fullName: u.name ? u.name.fullName : u.primaryEmail },
        suspended: !!u.suspended,
        orgUnitPath: u.orgUnitPath,
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return { users: users };
}

/* ============================================================
   COURSES — domain-wide, including owner-deactivated courses
   ============================================================ */
function getCourses(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get(COURSE_CACHE_KEY);
    if (cached) return { courses: JSON.parse(cached), cached: true };
  }

  // Classroom.Courses.list with no teacherId/studentId filter returns every
  // course in the domain when called by a domain admin with Classroom admin
  // privileges. Crucially, courses are NOT removed when their owning
  // teacher's account is suspended or deleted — the course record persists
  // with its original ownerId — so this single domain-wide sweep is what
  // surfaces "owner deactivated" courses, rather than iterating over
  // (necessarily active) teacher accounts per OU.
  const allCourses = [];
  let pageToken;
  const courseStates = ['ACTIVE', 'ARCHIVED', 'PROVISIONED', 'DECLINED'];
  do {
    const resp = Classroom.Courses.list({
      courseStates: courseStates,
      pageSize: 200,
      pageToken: pageToken,
    });
    (resp.courses || []).forEach(function (c) { allCourses.push(c); });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  // Resolve each course's owner (teacher) status in bulk. ownerId is a
  // Directory user ID, not always an email, so resolve via AdminDirectory.
  const ownerIds = uniq(allCourses.map(function (c) { return c.ownerId; }).filter(Boolean));
  const ownerStatus = resolveOwnerStatuses(ownerIds);

  const courses = allCourses.map(function (c) {
    const owner = ownerStatus[c.ownerId];
    return {
      id: c.id,
      name: c.name,
      section: c.section || '',
      courseState: c.courseState,
      ownerId: c.ownerId,
      ownerEmail: owner ? owner.email : '',
      // true when the owning teacher's account is suspended or no longer
      // exists in Directory (deleted) — this is the "Owner deactivated" flag.
      ownerInactive: owner ? owner.inactive : true,
    };
  });

  cache.put(COURSE_CACHE_KEY, JSON.stringify(courses), COURSE_CACHE_SECONDS);
  return { courses: courses, cached: false };
}

/**
 * Looks up each Directory user ID and reports whether the account is
 * suspended or missing entirely (deleted). Batches lookups defensively
 * since AdminDirectory.Users.get() has no native batch call in the
 * Advanced Service, but each call is cheap and results are cached above.
 */
function resolveOwnerStatuses(ownerIds) {
  const out = {};
  ownerIds.forEach(function (id) {
    try {
      const u = AdminDirectory.Users.get(id, { projection: 'basic' });
      out[id] = { email: u.primaryEmail, inactive: !!u.suspended };
    } catch (err) {
      // 404 => the user account was deleted entirely; still an "inactive owner".
      out[id] = { email: '', inactive: true };
    }
  });
  return out;
}

function uniq(arr) {
  const seen = {};
  const out = [];
  arr.forEach(function (v) {
    if (!seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

/* ============================================================
   COURSE MEMBERS
   ============================================================ */
function getCourseMembers(courseId) {
  if (!courseId) throw new Error('courseId is required');
  const teachers = listAllPages(function (pageToken) {
    return Classroom.Courses.Teachers.list(courseId, { pageToken: pageToken, pageSize: 100 });
  }, 'teachers');
  const students = listAllPages(function (pageToken) {
    return Classroom.Courses.Students.list(courseId, { pageToken: pageToken, pageSize: 100 });
  }, 'students');
  return { teachers: teachers, students: students };
}

function listAllPages(fetchPage, key) {
  const items = [];
  let pageToken;
  do {
    const resp = fetchPage(pageToken);
    (resp[key] || []).forEach(function (item) { items.push(item); });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

/* ============================================================
   MUTATIONS
   ============================================================ */
function addTeacher(courseId, teacherEmail) {
  if (!courseId || !teacherEmail) throw new Error('courseId and teacherEmail are required');
  Classroom.Courses.Teachers.create({ userId: teacherEmail }, courseId);
  return {};
}

function removeTeacher(courseId, teacherEmail) {
  if (!courseId || !teacherEmail) throw new Error('courseId and teacherEmail are required');
  Classroom.Courses.Teachers.remove(courseId, teacherEmail);
  return {};
}

function addStudent(courseId, studentEmail) {
  if (!courseId || !studentEmail) throw new Error('courseId and studentEmail are required');
  Classroom.Courses.Students.create({ userId: studentEmail }, courseId);
  return {};
}

function removeStudent(courseId, studentEmail) {
  if (!courseId || !studentEmail) throw new Error('courseId and studentEmail are required');
  Classroom.Courses.Students.remove(courseId, studentEmail);
  return {};
}
