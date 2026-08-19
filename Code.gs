/**
 * Classroom Admin — Apps Script backend
 * -------------------------------------
 * Deploy this as a Web App:
 *   Deploy > New deployment > Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone within [your domain]  (or "Anyone" if you prefer,
 *     since the app is protected by the password/token login regardless)
 *
 * Required Advanced Services (Extensions > Services in the Apps Script editor):
 *   - Admin SDK API      (identifier: AdminDirectory)
 *   - Google Classroom API (identifier: Classroom)
 * These also need to be enabled in the linked Google Cloud project
 * (APIs & Services > Library) if you're on a Workspace account.
 *
 * ONE-TIME SETUP:
 *   1. Open this script in the Apps Script editor.
 *   2. Select the `setup` function in the toolbar dropdown and click Run.
 *      (Edit the password inside `setup()` first!)
 *   3. Delete/forget the plaintext password from this file after running
 *      setup once if you want — it's now stored in Script Properties, not
 *      in your source code.
 */

// ==================== ONE-TIME SETUP ====================

/**
 * Run this once manually from the Apps Script editor to store your admin
 * password in Script Properties (never exposed to the frontend).
 */
function setup() {
  PropertiesService.getScriptProperties().setProperty(
    'ADMIN_PASSWORD',
    'admin'
  );
}

// How long a login session stays valid before requiring a fresh password.
var SESSION_DURATION_SECONDS = 6 * 60 * 60; // 6 hours (CacheService max is 6h)

// ==================== ENTRY POINTS ====================

function doGet(e) {
  return handleRequest(e.parameter || {});
}

function doPost(e) {
  var body = {};
  try {
    // Frontend sends Content-Type: text/plain to avoid a CORS preflight,
    // but the body content is still a JSON string — parse it manually.
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON in request body.' });
  }
  return handleRequest(body);
}

function handleRequest(params) {
  var action = params.action;

  try {
    if (!action) {
      return jsonResponse({ success: false, error: 'Missing "action" parameter.' });
    }

    // --- Unauthenticated actions ---
    if (action === 'login') {
      return jsonResponse(login(params.password));
    }
    if (action === 'logout') {
      return jsonResponse(logout(params.token));
    }

    // --- Every other action requires a valid session token ---
    if (!verifyToken(params.token)) {
      return jsonResponse({
        success: false,
        unauthorized: true,
        error: 'Session expired. Please log in again.'
      });
    }

    switch (action) {
      case 'getOUs':
        return jsonResponse(getOUs());
      case 'getUsersByOU':
        return jsonResponse(getUsersByOU(params.orgUnitPath));
      case 'getCourseMembers':
        return jsonResponse(getCourseMembers(params.courseId));
      case 'addTeacher':
        return jsonResponse(addTeacher(params.courseId, params.teacherEmail));
      case 'addStudent':
        return jsonResponse(addStudent(params.courseId, params.studentEmail));
      case 'removeTeacher':
        return jsonResponse(removeTeacher(params.courseId, params.teacherEmail));
      case 'removeStudent':
        return jsonResponse(removeStudent(params.courseId, params.studentEmail));
      default:
        return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: (err && err.message) || String(err) });
  }
}

/**
 * Wraps a plain object as JSON output. Apps Script web apps automatically
 * send the necessary CORS header (Access-Control-Allow-Origin: *) for
 * simple GET/POST requests — no extra header-setting is possible or needed
 * here since ContentService doesn't expose custom header methods.
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== AUTH ====================

function login(password) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!stored) {
    return { success: false, error: 'Admin password has not been configured. Run setup() in the Apps Script editor.' };
  }
  if (!password || password !== stored) {
    return { success: false, error: 'Incorrect password.' };
  }
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, 'valid', SESSION_DURATION_SECONDS);
  return { success: true, token: token, expiresIn: SESSION_DURATION_SECONDS };
}

function logout(token) {
  if (token) {
    CacheService.getScriptCache().remove('session_' + token);
  }
  return { success: true };
}

function verifyToken(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('session_' + token) === 'valid';
}

// ==================== DIRECTORY (OUs & Users) ====================
// Requires the "Admin SDK API" advanced service (AdminDirectory).

function getOUs() {
  var ous = [];
  var pageToken;
  do {
    var resp = AdminDirectory.Orgunits.list('my_customer', {
      type: 'all',
      pageToken: pageToken
    });
    (resp.organizationUnits || []).forEach(function (ou) {
      ous.push({ name: ou.name, orgUnitPath: ou.orgUnitPath });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  ous.sort(function (a, b) { return a.orgUnitPath.localeCompare(b.orgUnitPath); });
  return { success: true, ous: ous };
}

function getUsersByOU(orgUnitPath) {
  if (!orgUnitPath) return { success: false, error: 'orgUnitPath is required.' };

  var users = [];
  var pageToken;
  do {
    var resp = AdminDirectory.Users.list({
      customer: 'my_customer',
      query: "orgUnitPath='" + orgUnitPath + "'",
      maxResults: 100,
      pageToken: pageToken
    });
    (resp.users || []).forEach(function (u) {
      users.push({
        primaryEmail: u.primaryEmail,
        fullName: u.name ? u.name.fullName : u.primaryEmail,
        suspended: !!u.suspended
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return { success: true, users: users };
}

// ==================== CLASSROOM ====================
// Requires the "Google Classroom API" advanced service (Classroom).

function getCourseMembers(courseId) {
  if (!courseId) return { success: false, error: 'courseId is required.' };

  var teachers = [];
  var students = [];
  var pageToken;

  do {
    var tResp = Classroom.Courses.Teachers.list(courseId, { pageToken: pageToken });
    (tResp.teachers || []).forEach(function (t) {
      teachers.push({
        email: t.profile.emailAddress,
        name: t.profile.name ? t.profile.name.fullName : t.profile.emailAddress
      });
    });
    pageToken = tResp.nextPageToken;
  } while (pageToken);

  pageToken = undefined;
  do {
    var sResp = Classroom.Courses.Students.list(courseId, { pageToken: pageToken });
    (sResp.students || []).forEach(function (s) {
      students.push({
        email: s.profile.emailAddress,
        name: s.profile.name ? s.profile.name.fullName : s.profile.emailAddress
      });
    });
    pageToken = sResp.nextPageToken;
  } while (pageToken);

  return { success: true, teachers: teachers, students: students };
}

function addTeacher(courseId, teacherEmail) {
  if (!courseId || !teacherEmail) {
    return { success: false, error: 'courseId and teacherEmail are required.' };
  }
  Classroom.Courses.Teachers.create({ userId: teacherEmail }, courseId);
  return { success: true };
}

function addStudent(courseId, studentEmail) {
  if (!courseId || !studentEmail) {
    return { success: false, error: 'courseId and studentEmail are required.' };
  }
  Classroom.Courses.Students.create({ userId: studentEmail }, courseId);
  return { success: true };
}

function removeTeacher(courseId, teacherEmail) {
  if (!courseId || !teacherEmail) {
    return { success: false, error: 'courseId and teacherEmail are required.' };
  }
  Classroom.Courses.Teachers.remove(courseId, teacherEmail);
  return { success: true };
}

function removeStudent(courseId, studentEmail) {
  if (!courseId || !studentEmail) {
    return { success: false, error: 'courseId and studentEmail are required.' };
  }
  Classroom.Courses.Students.remove(courseId, studentEmail);
  return { success: true };
}
