const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

require("dotenv").config();

const app = express(); app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

app.use(express.static(path.join(__dirname)));

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {
  const schemaPath = path.join(__dirname, "schema.sql");

  if (!fs.existsSync(schemaPath)) {
    throw new Error("schema.sql не найден");
  }

  const schema = fs.readFileSync(schemaPath, "utf8");

  console.log("Инициализация базы данных...");

  await pool.query(schema);
  if (process.env.ADMIN_EMAIL) {
  await pool.query(
    "UPDATE users SET is_admin = TRUE WHERE email = $1",
    [process.env.ADMIN_EMAIL.toLowerCase()]
  );

  console.log("Администратор проверен.");
}

  // Если таблица orders уже существовала со старой схемой,
  // добавляем недостающие PayU-поля.
  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS ext_order_id TEXT UNIQUE
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payu_order_id TEXT
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS program_id BIGINT REFERENCES programs(id)
  `);

  console.log("База данных готова.");
}

/* =========================================================
   AUTH
========================================================= */

app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password || password.length < 8) {
      return res.status(400).json({
        error: "Нужны e-mail и пароль минимум 8 символов"
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users(email, password_hash)
      VALUES($1, $2)
      RETURNING id, email
      `,
      [email.toLowerCase(), hash]
    );

    req.session.userId = result.rows[0].id;

    res.json({
      user: result.rows[0]
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);

    res.status(400).json({
      error:
        e.code === "23505"
          ? "Пользователь уже существует"
          : "Ошибка регистрации"
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase();
    const password = req.body.password || "";

    const result = await pool.query(
      `
      SELECT id, email, is_admin, password_hash
      FROM users
      WHERE email = $1
      `,
      [email]
    );

    if (
      !result.rowCount ||
      !(await bcrypt.compare(
        password,
        result.rows[0].password_hash
      ))
    ) {
      return res.status(401).json({
        error: "Неверный e-mail или пароль"
      });
    }

    req.session.userId = result.rows[0].id;

    res.json({
      id: result.rows[0].id,
      email: result.rows[0].email,
      isAdmin: result.rows[0].is_admin
    });
  } catch (e) {
    console.error("LOGIN ERROR:", e);

    res.status(500).json({
      error: "Ошибка входа"
    });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({
        user: null
      });
    }

    const result = await pool.query(
      `
      SELECT id, email, is_admin
      FROM users
      WHERE id = $1
      `,
      [req.session.userId]
    );

    res.json({
      user: result.rows[0] || null
    });
  } catch (e) {
    console.error("ME ERROR:", e);

    res.status(500).json({
      error: "Ошибка"
    });
  }
});

/* =========================================================
   PROGRAMS
========================================================= */

app.get("/api/programs", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        category,
        description,
        price_pln,
        weeks,
        content_url
      FROM programs
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (e) {
    console.error("PROGRAMS ERROR:", e);

    res.status(500).json({
      error: "Ошибка загрузки программ"
    });
  }
});

/* =========================================================
   ADMIN
========================================================= */

function admin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Требуется вход"
    });
  }

  pool
    .query(
      `
      SELECT is_admin
      FROM users
      WHERE id = $1
      `,
      [req.session.userId]
    )
    .then((result) => {
      if (
        result.rowCount &&
        result.rows[0].is_admin
      ) {
        next();
      } else {
        res.status(403).json({
          error: "Нет доступа"
        });
      }
    })
    .catch((e) => {
      console.error("ADMIN ERROR:", e);

      res.status(500).json({
        error: "Ошибка"
      });
    });
}

app.post("/api/admin/programs", admin, async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      price,
      weeks
    } = req.body;

    if (!title || !category || isNaN(price)) {
      return res.status(400).json({
        error: "Заполни название, категорию и цену"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO programs(
        title,
        category,
        description,
        price_pln,
        weeks
      )
      VALUES($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        title,
        category,
        description || "",
        price,
        weeks || null
      ]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error("ADMIN PROGRAM CREATE ERROR:", e);

    res.status(500).json({
      error: "Ошибка создания программы"
    });
  }
});

app.delete(
  "/api/admin/programs/:id",
  admin,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM programs
        WHERE id = $1
        `,
        [req.params.id]
      );

      res.json({
        ok: true
      });
    } catch (e) {
      console.error("ADMIN PROGRAM DELETE ERROR:", e);

      res.status(500).json({
        error: "Ошибка удаления программы"
      });
    }
  }
);
/* =========================================================
   WORKOUTS
========================================================= */

// Получить тренировки программы
app.get("/api/programs/:programId/workouts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        w.id,
        w.program_id,
        w.week,
        w.day,
        w.title,
        w.description
      FROM workouts w
      WHERE w.program_id = $1
      ORDER BY w.week ASC, w.day ASC, w.id ASC
    `, [req.params.programId]);

    res.json(result.rows);

  } catch (e) {
    console.error("WORKOUTS ERROR:", e);

    res.status(500).json({
      error: "Ошибка загрузки тренировок"
    });
  }
});


// Получить упражнения конкретной тренировки
app.get("/api/workouts/:workoutId/exercises", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        workout_id,
        name,
        sets,
        reps,
        weight,
        rest,
        video_url,
        notes,
        position
      FROM exercises
      WHERE workout_id = $1
      ORDER BY position ASC, id ASC
    `, [req.params.workoutId]);

    res.json(result.rows);

  } catch (e) {
    console.error("EXERCISES ERROR:", e);

    res.status(500).json({
      error: "Ошибка загрузки упражнений"
    });
  }
});


// Админ: создать тренировочный день
app.post("/api/admin/workouts", admin, async (req, res) => {
  try {

    const {
      programId,
      week,
      day,
      title,
      description
    } = req.body;

    if (!programId || !title) {
      return res.status(400).json({
        error: "Нужны программа и название тренировки"
      });
    }

    const result = await pool.query(`
      INSERT INTO workouts(
        program_id,
        week,
        day,
        title,
        description
      )
      VALUES($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      programId,
      Number(week) || 1,
      Number(day) || 1,
      title,
      description || ""
    ]);

    res.json(result.rows[0]);

  } catch (e) {

    console.error("WORKOUT CREATE ERROR:", e);

    res.status(500).json({
      error: "Ошибка создания тренировки"
    });
  }
});


// Админ: удалить тренировку
app.delete("/api/admin/workouts/:id", admin, async (req, res) => {
  try {

    await pool.query(`
      DELETE FROM workouts
      WHERE id = $1
    `, [req.params.id]);

    res.json({
      ok: true
    });

  } catch (e) {

    console.error("WORKOUT DELETE ERROR:", e);

    res.status(500).json({
      error: "Ошибка удаления тренировки"
    });
  }
});


// Админ: добавить упражнение
app.post("/api/admin/exercises", admin, async (req, res) => {
  try {

    const {
      workoutId,
      name,
      sets,
      reps,
      weight,
      rest,
      videoUrl,
      notes,
      position
    } = req.body;

    if (!workoutId || !name) {
      return res.status(400).json({
        error: "Нужны тренировка и название упражнения"
      });
    }

    const result = await pool.query(`
      INSERT INTO exercises(
        workout_id,
        name,
        sets,
        reps,
        weight,
        rest,
        video_url,
        notes,
        position
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      workoutId,
      name,
      sets || null,
      reps || "",
      weight || "",
      rest || "",
      videoUrl || "",
      notes || "",
      Number(position) || 0
    ]);

    res.json(result.rows[0]);

  } catch (e) {

    console.error("EXERCISE CREATE ERROR:", e);

    res.status(500).json({
      error: "Ошибка создания упражнения"
    });
  }
});


// Админ: удалить упражнение
app.delete("/api/admin/exercises/:id", admin, async (req, res) => {
  try {

    await pool.query(`
      DELETE FROM exercises
      WHERE id = $1
    `, [req.params.id]);

    res.json({
      ok: true
    });

  } catch (e) {

    console.error("EXERCISE DELETE ERROR:", e);

    res.status(500).json({
      error: "Ошибка удаления упражнения"
    });
  }
});
/* =========================================================
   PAYU SANDBOX
========================================================= */

async function payuToken() {
  const base =
    process.env.PAYU_BASE_URL ||
    "https://secure.snd.payu.com";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.PAYU_CLIENT_ID || "",
    client_secret:
      process.env.PAYU_CLIENT_SECRET || ""
  });

  const response = await fetch(
    base + "/pl/standard/user/oauth/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      "PayU OAuth failed: " + text
    );
  }

  const data = await response.json();

  return data.access_token;
}

app.post(
  "/api/payu/create-order",
  async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({
          error: "Сначала войдите"
        });
      }

      const { programId } = req.body;

      const programResult = await pool.query(
        `
        SELECT id, title, price_pln
        FROM programs
        WHERE id = $1
        `,
        [programId]
      );

      if (!programResult.rowCount) {
        return res.status(404).json({
          error: "Программа не найдена"
        });
      }

      const program = programResult.rows[0];

      const extOrderId =
        "BG" +
        Date.now() +
        crypto
          .randomBytes(4)
          .toString("hex");

      const token = await payuToken();

      const base =
        process.env.PAYU_BASE_URL ||
        "https://secure.snd.payu.com";

      const amount = Math.round(
        Number(program.price_pln) * 100
      );

      const order = {
        notifyUrl:
          process.env.PAYU_NOTIFY_URL,

        continueUrl:
          process.env.PAYU_CONTINUE_URL,

        customerIp:
          req.ip,

        merchantPosId:
          process.env.PAYU_POS_ID,

        description:
          "Bizon GYM - " +
          program.title,

        currencyCode: "PLN",

        totalAmount:
          String(amount),

        extOrderId,

        products: [
          {
            name: program.title,
            unitPrice:
              String(amount),
            quantity: "1"
          }
        ]
      };

      const response = await fetch(
        base + "/api/v2_1/orders",
        {
          method: "POST",
          headers: {
            Authorization:
              "Bearer " + token,

            "Content-Type":
              "application/json"
          },
          body: JSON.stringify(order)
        }
      );

      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        data = {
          raw: text
        };
      }

      if (
        response.status !== 200 &&
        response.status !== 201 &&
        response.status !== 302
      ) {
        return res.status(502).json({
          error:
            "PayU не принял заказ",
          details: data
        });
      }

      const redirect =
        data.redirectUri;

      await pool.query(
        `
        INSERT INTO orders(
          user_id,
          status,
          total_pln,
          ext_order_id,
          program_id,
          payu_order_id
        )
        VALUES(
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          req.session.userId,
          "PENDING",
          program.price_pln,
          extOrderId,
          program.id,
          data.orderId || null
        ]
      );

      res.json({
        redirectUri: redirect,
        orderId: data.orderId
      });
    } catch (e) {
      console.error(
        "PAYU CREATE ORDER ERROR:",
        e
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================================================
   PAYU NOTIFICATION
========================================================= */

app.post(
  "/api/payu/notify",
  async (req, res) => {
    try {
      const order = req.body?.order;

      if (!order) {
        return res.sendStatus(200);
      }

      await pool.query(
        `
        UPDATE orders
        SET
          status = $1,
          payu_order_id = $2
        WHERE ext_order_id = $3
        `,
        [
          order.status,
          order.orderId,
          order.extOrderId
        ]
      );

      // Доступ выдаём только после COMPLETED.
      if (order.status === "COMPLETED") {
        await pool.query(
          `
          INSERT INTO entitlements(
            user_id,
            program_id,
            order_id
          )
          SELECT
            user_id,
            program_id,
            id
          FROM orders
          WHERE ext_order_id = $1
          ON CONFLICT DO NOTHING
          `,
          [order.extOrderId]
        );
      }

      res.sendStatus(200);
    } catch (e) {
      console.error(
        "PAYU NOTIFY ERROR:",
        e
      );

      res.sendStatus(500);
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await initDatabase();

    const port =
      process.env.PORT || 3000;

    app.listen(
      port,
      "0.0.0.0",
      () => {
        console.log(
          "Bizon GYM server started on port " +
          port
        );
      }
    );
  } catch (e) {
    console.error(
      "DATABASE INITIALIZATION ERROR:",
      e
    );

    process.exit(1);
  }
}

startServer();
