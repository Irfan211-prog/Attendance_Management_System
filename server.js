// --------------------- IMPORTS ---------------------
require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const multer = require("multer");
const bcrypt = require("bcrypt");
const ExcelJS = require("exceljs");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const { Pool } = require("pg");
const { spawn } = require("child_process");
// Cloudinary
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// --------------------- APP SETUP ---------------------
const app = express();
const PORT = 3000;
const FACULTY_SECRET = "IIITDM2026";
app.use(session({
  secret: "secretkey",
  resave: false,
  saveUninitialized: false,
}));

app.set('trust proxy', 1);
const ALLOW_NGROK = false;

function getIP(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";

  // Handle multiple IPs (proxy case)
  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  // Convert IPv6 → IPv4
  if (ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }

  return ip;
}

app.use((req, res, next) => {
  const ip = getIP(req);
  const forwarded = req.headers["x-forwarded-for"];

  console.log("Client IP:", ip);
  console.log("Forwarded IP:", forwarded);

  const isCollegeNetwork = ip.startsWith("172.16.") || ip.startsWith("2409:40f0:201f:3c21:8000::");
  const isLocalhost = ip === "127.0.0.1" || ip === "::1";
  const isNgrok = forwarded && ALLOW_NGROK;

  if (isCollegeNetwork || isLocalhost || isNgrok) {
    return next();
  }

  console.log("❌ BLOCKED:", ip);
  return res.status(403).send("❌ Only college network allowed");
});

// --------------------- PostgreSQL ---------------------
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "Attendance_System",
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// --------------------- Cloudinary Config ---------------------
cloudinary.config({
  cloud_name: "ddmaug5s1",   // 🔥 replace this
  api_key: "742958454836297",
  api_secret: process.env.CLOUDINARY_API_SECRET,   // 🔥 replace this
});

// --------------------- Middleware ---------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(express.static(__dirname)); // Serve all files in root
// Prevent browser caching for protected pages
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

function isAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/student_login");
  }
  next();
}

// --------------------- Multer + Cloudinary ---------------------
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "students",
    allowed_formats: ["jpg", "png", "jpeg"],
  },
});

const upload = multer({ storage });

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// 🔥 NEW multer for timetable (PDF)
const timetableStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const facultyId = req.body.facultyId || "unknown";
    cb(null, facultyId + "_" + Date.now() + ".pdf");
  }
});

const uploadTimetable = multer({ storage: timetableStorage });

// --------------------- ROUTES ---------------------

// Front Page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "FrontPage.html"));
});

// Student Login Page
app.get("/student_login", (req, res) => {
  res.sendFile(path.join(__dirname, "StudentLogin.html"));
});

app.get('/api/check-session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true });
  } else {
    res.json({ loggedIn: false });
  }
});

// --------------------- SIGNUP ---------------------
app.post("/signup", upload.single("photo"), async (req, res) => {
  console.log("🔥 HIT /signup");
  console.log("BODY:", req.body);
  console.log("FILE:", req.file);

  try {
    const { fullname, roll, email, password, confirmPassword, year} = req.body;

    // 🔥 Cloudinary URL
    const photo = req.file ? req.file.path : null;

    // Validation
    if (!fullname || !roll || !email || !password || !confirmPassword) {
      return res.status(400).send("All fields are required");
    }

    if (password !== confirmPassword) {
      return res.status(400).send("Passwords do not match");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert into DB
    await pool.query(
      "INSERT INTO students (fullname, roll, email, photo, password, year) VALUES ($1, $2, $3, $4, $5, $6)",
      [fullname, roll, email, photo, hashedPassword, year]
    );

    res.json({ success: true, message: "Registration successful!" });
  } catch (err) {
    console.error("PostgreSQL error:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/api/mark-attendance", async (req, res) => {

  const { roll, course, faculty_id } = req.body;

  if (!roll || !course || !faculty_id ||
    !roll.trim() || !course.trim() || !faculty_id.trim()) {
    return res.json({
      success: false,
      message: "Missing required fields"
    });
  }

  const today = new Date().toISOString().split("T")[0];

  try {
    console.log("ROLL:", roll);
    console.log("COURSE:", course);
    console.log("FACULTY:", faculty_id);

    // ✅ Check student
    const studentRes = await pool.query(
      "SELECT fullname FROM students WHERE roll = $1",
      [roll]
    );

    if (studentRes.rows.length === 0) {
      return res.json({ success: false, message: "Student not found" });
    }

    const name = studentRes.rows[0].fullname;

    // ✅ Validate class
    const classCheck = await pool.query(
      `SELECT * FROM timetable 
       WHERE subject=$1 AND faculty_id=$2`,
      [course, faculty_id]
    );

    if (classCheck.rows.length === 0) {
      return res.json({
        success: false,
        message: "Invalid class"
      });
    }

    // ✅ Check existing attendance
    const check = await pool.query(
      `SELECT * FROM attendance
       WHERE roll=$1 AND course=$2 AND date=$3`,
      [roll, course, today]
    );

    // 🔥 FIXED PART (NO INCREMENT ANYMORE)
    if (check.rows.length > 0) {

      await pool.query(
        `UPDATE attendance
         SET last_date = NOW()
         WHERE roll=$1 AND course=$2 AND date=$3`,
        [roll, course, today]
      );

      return res.json({
        success: true,
        message: "Attendance already marked for today"
      });
    }

    // ✅ Insert new attendance (only first time)
    await pool.query(
      `INSERT INTO attendance
       (roll, name, course, faculty_id, date, count, last_date)
       VALUES ($1,$2,$3,$4,$5,1,NOW())`,
      [roll, name, course, faculty_id, today]
    );

    return res.json({
      success: true,
      message: "Attendance marked successfully"
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

app.get("/api/faculty-courses", isAuthenticated, async (req, res) => {
  const facultyId = req.session.user; // ✅ ONLY from session

  try {
    const result = await pool.query(
      `SELECT DISTINCT subject 
       FROM timetable 
       WHERE faculty_id = $1`,
      [facultyId]
    );

    const courses = result.rows.map(row => row.subject);

    res.json(courses);

  } catch (err) {
    console.error("Error fetching courses:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/current-class", async (req, res) => {
  let { year } = req.query;

  if (!year) {
    return res.status(400).json({ error: "Year is required" });
  }

  year = year.trim() + " Year";

  const now = new Date();
  const day = now.toLocaleString("en-US", { weekday: "long" });
  const time = now.toTimeString().split(" ")[0]; // ✅ "23:10:00"

  try {
    const result = await pool.query(
      `SELECT * FROM timetable
      WHERE day = $1
      AND year = $2
      AND (
        (start_time <= end_time AND start_time <= $3::time AND end_time >= $3::time)
        OR
        (start_time > end_time AND ($3::time >= start_time OR $3::time <= end_time))
      )`,
      [day, year, time]
    );

    if (result.rows.length > 0) {
      res.json({ active: true, class: result.rows[0] });
    } else {
      res.json({ active: false });
    }
    console.log("DAY:", day);
    console.log("MATCHING YEAR:", year);
    console.log("TIME:", time);
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// --------------------- LOGIN ---------------------
app.post("/login", async (req, res) => {
  try {
    const { roll, password } = req.body;

    if (!roll || !password) {
      return res.send(`
        <script>
          alert("❌ Roll number and password are required");
          window.location.href = "/student_login";
        </script>
      `);
    }

    const result = await pool.query(
      "SELECT * FROM students WHERE roll = $1",
      [roll]
    );

    if (result.rows.length === 0) {
      return res.send(`
        <script>
          alert("❌ Roll number not found");
          window.location.href = "/student_login";
        </script>
      `);
    }

    const student = result.rows[0];

    const match = await bcrypt.compare(password, student.password);

    if (match) {
      req.session.user = student.roll; // ✅ ADD THIS

      return res.redirect(
        `/StudentDashboard.html?roll=${encodeURIComponent(student.roll)}`
      );
    }else {
      return res.send(`
        <script>
          alert("❌ Incorrect password");
          window.location.href = "/student_login";
        </script>
      `);
    }

  } catch (err) {
    console.error("Login error:", err.message);
    res.send(`
      <script>
        alert("❌ Server error");
        window.location.href = "/student_login";
      </script>
    `);
  }
});



app.get("/StudentDashboard.html", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "StudentDashboard.html"));
});

app.get("/FacultyDashboard.html", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "FacultyDashboard.html"));
});

app.get("/mark", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "mark.html"));
});

app.get("/api/student/:roll", isAuthenticated, async (req, res) => {
  const { roll } = req.params;

  try {
    const result = await pool.query(
      "SELECT fullname, roll, email, photo,year FROM students WHERE roll = $1",
      [roll]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }

    res.json(result.rows[0]); // Send student data as JSON
  } catch (err) {
    console.error("PostgreSQL error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Faculty

// --------------------- FACULTY SIGNUP ---------------------
app.post("/faculty/signup", upload.single("photo"), async (req, res) => {
  try {
    const { fullname, facultyId, email, password, confirmPassword, secretCode } = req.body;
    const photo_url = req.file ? req.file.path : null;

    // 🔒 SECRET CODE VALIDATION
    if (secretCode !== FACULTY_SECRET) {
      return res.status(403).send("❌ Invalid Secret Code");
    }

    // Validation
    if (!fullname || !facultyId || !email || !password || !confirmPassword) {
      return res.status(400).send("All fields are required");
    }

    if (password !== confirmPassword) {
      return res.status(400).send("Passwords do not match");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert into DB
    await pool.query(
      "INSERT INTO faculties (fullname, roll, email, password, photo_url) VALUES ($1, $2, $3, $4, $5)",
      [fullname, facultyId, email, hashedPassword, photo_url]
    );

    res.send("✅ Faculty registration successful!");
  } catch (err) {
    console.error("Faculty signup error:", err.message);
    res.status(500).send("Server error: " + err.message);
  }
});

// --------------------- FACULTY LOGIN ---------------------
app.post("/faculty/login", async (req, res) => {
  try {
    const { facultyId, password } = req.body;

    if (!facultyId || !password) {
      return res.status(400).send("Faculty ID and password are required");
    }

    const result = await pool.query(
      "SELECT * FROM faculties WHERE roll = $1",
      [facultyId]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Faculty ID not found");
    }

    const faculty = result.rows[0];
    const match = await bcrypt.compare(password, faculty.password);

    if (match) {
      // ✅ Set session
      req.session.user = faculty.roll;

      // Redirect to dashboard
      return res.redirect(`/FacultyDashboard.html?roll=${encodeURIComponent(faculty.roll)}`);
    } else {
      return res.status(400).send("Incorrect password");
    }
  } catch (err) {
    console.error("Faculty login error:", err.message);
    res.status(500).send("Server error");
  }
});

app.get("/api/faculty/:roll",isAuthenticated, async (req, res) => {
  const { roll } = req.params;

  try {
    const result = await pool.query(
      "SELECT fullname, roll, email, photo_url FROM faculties WHERE roll = $1",
      [roll]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Faculty not found" });
    }

    res.json(result.rows[0]); // Send faculty data as JSON
  } catch (err) {
    console.error("PostgreSQL error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/students", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT fullname, roll, photo FROM students"
    );

    res.json(result.rows); // Send array of students
  } catch (err) {
    console.error("PostgreSQL error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/upload_timetable.html", (req, res) => {
  res.sendFile(path.join(__dirname, "upload_timetable.html"));
});

app.post("/api/upload-timetable", uploadTimetable.single("pdf"), async (req, res) => {
  try {

    // ✅ SESSION FACULTY ID
    const facultyId = req.session.user;

    if (!facultyId) {
      return res.status(401).json({ error: "Faculty not logged in" });
    }

    const filePath = req.file.path;
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);

    const text = pdfData.text;
    const lines = text.split("\n");

    const records = [];

    // 🔥 PARSE TIMETABLE
    lines.forEach(line => {
      line = line.replace(/–/g, "-");
      line = line.replace(/\s+/g, " ").trim();

      const match = line.match(
        /(Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)\s+\((\d+)(?:st|nd|rd|th)?\s+Year\)/i
      );

      if (match) {
        records.push({
          day: match[1],
          start: match[2],
          end: match[3],
          subject: match[4],
          year: match[5] + " Year"
        });
      }
    });

    let inserted = 0;
    let skipped = 0;

    // 🔥 INSERT WITH DUPLICATE HANDLING
    for (const r of records) {
      try {
        await pool.query(
          `INSERT INTO timetable 
          (faculty_id, day, subject, year, start_time, end_time)
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [facultyId, r.day, r.subject, r.year, r.start, r.end]
        );
        inserted++;
      } catch (err) {
        if (err.code === "23505") {
          skipped++; // duplicate
        } else {
          throw err;
        }
      }
    }

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      facultyId,
      inserted,
      skipped,
      totalParsed: records.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.get("/api/timetable", isAuthenticated, async (req, res) => {
  try {
    const facultyId = req.session.user;

    const result = await pool.query(
      `SELECT * FROM timetable 
       WHERE faculty_id = $1
       ORDER BY day, start_time`,
      [facultyId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch timetable" });
  }
});

app.delete("/api/timetable/:id", isAuthenticated, async (req, res) => {
  try {
    const facultyId = req.session.user;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM timetable 
       WHERE id = $1 AND faculty_id = $2`,
      [id, facultyId]
    );

    res.json({
      success: true,
      message: "Deleted successfully"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
});

app.get("/download-excel", isAuthenticated, async (req, res) => {

  const faculty_id = req.session.user; // ✅ GET FROM SESSION
  const { course } = req.query;

  if (!faculty_id || !course) {
    return res.status(400).send("Course is required");
  }

  try {
    // Get attendance records for this course and faculty
    const result = await pool.query(
      "SELECT roll, name, count, last_date FROM attendance WHERE faculty_id = $1 AND course = $2",
      [faculty_id, course]
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Attendance");

    // Add headers
    worksheet.columns = [
      { header: "Roll Number", key: "roll", width: 20 },
      { header: "Name", key: "name", width: 30 },
      { header: "Attendance Count", key: "count", width: 20 },
      { header: "Last Date", key: "last_date", width: 15 },
    ];

    // Add rows
    result.rows.forEach(row => {
      worksheet.addRow({
        roll: row.roll,
        name: row.name,
        count: row.count,
        last_date: row.last_date ? row.last_date.toISOString().split("T")[0] : ""
      });
    });

    // Set response headers
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${course}_attendance.xlsx`
    );

    // Send file
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Error generating Excel:", err);
    res.status(500).send("Server error while generating Excel");
  }
});

app.get("/api/review-attendance", async (req, res) => {
  const facultyId = req.query.facultyId;

  if (!facultyId) {
    return res.status(400).json({ error: "facultyId required" });
  }

  try {

    // 1. PRESENT (last 2 hours)
    const presentResult = await pool.query(
      `
      SELECT roll, name, course
      FROM attendance
      WHERE faculty_id = $1
      AND last_date >= (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '2 hours'
      `,
      [facultyId]
    );

    // 🔥 COURSE-WISE PRESENT MAP (IMPORTANT FIX)
    const presentMap = {};

    presentResult.rows.forEach(s => {
      if (!presentMap[s.course]) {
        presentMap[s.course] = new Set();
      }
      presentMap[s.course].add(s.roll);
    });

    // grouped present output
    const presentGrouped = {};

    presentResult.rows.forEach(s => {
      if (!presentGrouped[s.course]) presentGrouped[s.course] = [];

      presentGrouped[s.course].push({
        roll: s.roll,
        name: s.name
      });
    });

    // 2. COURSE → YEAR
    const timetableResult = await pool.query(
      `SELECT DISTINCT subject, year FROM timetable WHERE faculty_id = $1`,
      [facultyId]
    );

    const courseYearMap = {};
    timetableResult.rows.forEach(t => {
      courseYearMap[t.subject] = parseInt(t.year);
    });

    // 3. STUDENTS
    const studentsResult = await pool.query(
      `SELECT roll, fullname, year FROM students`
    );

    // 4. ABSENTEES (COURSE WISE FIXED)
    const absentGrouped = {};

    studentsResult.rows.forEach(student => {

      Object.keys(courseYearMap).forEach(course => {

        const courseYear = courseYearMap[course];

        const isPresentInThisCourse =
          presentMap[course]?.has(student.roll);   // 🔥 FIX HERE

        if (
          Number(student.year) === courseYear &&
          !isPresentInThisCourse
        ) {
          if (!absentGrouped[course]) absentGrouped[course] = [];

          absentGrouped[course].push({
            roll: student.roll,
            name: student.fullname
          });
        }
      });
    });

    res.json({
      present: presentGrouped,
      absent: absentGrouped
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/mark-present", async (req, res) => {
  const { roll, course, facultyId } = req.body;

  if (!roll || !course || !facultyId) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const query = `
    INSERT INTO attendance (roll, name, course, faculty_id, date, count, last_date)
    VALUES (
      $1::text,
      (SELECT s.fullname FROM students s WHERE s.roll::text = $1::text LIMIT 1),
      $2,
      $3,
      CURRENT_DATE,
      1,
      NOW()
    )
    ON CONFLICT (roll, course, date)
    DO UPDATE SET
      count = attendance.count + 1,
      last_date = NOW()
  `;

    await pool.query(query, [roll, course, facultyId]);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/student-attendance/:roll", isAuthenticated, async (req, res) => {
  const { roll } = req.params;

  try {
    const result = await pool.query(
      "SELECT course, count, last_date FROM attendance WHERE roll = $1",
      [roll]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch attendance" });
  }
});

app.post("/api/check75-attendance", isAuthenticated, async (req, res) => {
  const { course, facultyId, totalClasses } = req.body;

  try {
    const result = await pool.query(
      `SELECT roll, name, count 
       FROM attendance 
       WHERE course = $1 AND faculty_id = $2`,
      [course, facultyId]
    );

    if (result.rows.length === 0) {
      return res.json([]);
    }

    const defaulters = result.rows
      .map(row => {
        const percentage = (row.count / totalClasses) * 100;
        return {
          roll: row.roll,
          name: row.name,
          attendanceCount: row.count,
          percentage: percentage   // ✅ FIXED
        };
      })
      .filter(student => student.percentage < 75); // correct now

    res.json(defaulters);

  } catch (err) {
    console.error("Error in 75% API:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Logout Route
app.get("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ success: false });
    }
    res.clearCookie("connect.sid"); // Clear session cookie
    res.json({ success: true });    // Respond to frontend
  });
});

// Student logout
app.get("/student-logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ success: false, message: "Error logging out" });
    }
    res.clearCookie("connect.sid"); // Clear session cookie
    return res.json({ success: true });
  });
});

// --------------------- START SERVER ---------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on network`);
});