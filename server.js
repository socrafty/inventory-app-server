const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

app.use(cors());  // 반드시 CORS 허용
app.use(bodyParser.json());
app.use(express.static('public'));

// 재고 초기화 함수
const initializeInventory = () => {
  const truncateQuery = 'TRUNCATE TABLE inventory;';
  
  db.query(truncateQuery, (err) => {
    if (err) {
      console.error('Error truncating inventory:', err);
      return;
    }
    
    updateInventory();
    console.log('Inventory initialized');
  });
};

// MySQL 연결 설정
require('dotenv').config();
const db = mysql.createConnection({
  host: process.env.DB_HOST,      
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT 
});

// MySQL 연결
db.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
  }
  console.log('Connected to MySQL database');
  
  // 테이블 생성 쿼리
  const createTables = `
    CREATE TABLE IF NOT EXISTS inbound (
      id VARCHAR(36) PRIMARY KEY,
      drowingnumber VARCHAR(255) NOT NULL,
      specification VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      Finishing VARCHAR(255),
      supplier VARCHAR(255),
      note TEXT,
      date DATE NOT NULL,
      createdAt DATETIME NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS outbound (
      id VARCHAR(36) PRIMARY KEY,
      drowingnumber VARCHAR(255) NOT NULL,
      specification VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      Finishing VARCHAR(255),
      supplier VARCHAR(255),
      note TEXT,
      date DATE NOT NULL,
      createdAt DATETIME NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS inventory (
      id VARCHAR(36) PRIMARY KEY,
      drowingnumber VARCHAR(255) NOT NULL,
      specification VARCHAR(255) NOT NULL,
      stock INT NOT NULL,
      Finishing VARCHAR(255),
      supplier VARCHAR(255),
      note TEXT
    );
  `;
  
  // 테이블 생성 및 재고 초기화
  db.query(createTables, (err) => {
    if (err) throw err;
    console.log('Tables created or already exist');
    initializeInventory();
  });
});

// 재고 업데이트 함수
const updateInventory = () => {
  const truncateQuery = `TRUNCATE TABLE inventory;`;
  const insertQuery = `
    INSERT INTO inventory (id, drowingnumber, specification, stock, Finishing, supplier, note)
    SELECT 
      UUID() AS id,
      drowingnumber,
      specification,
      SUM(CASE WHEN type = 'inbound' THEN quantity ELSE -quantity END) AS stock,
      Finishing,
      supplier,
      note
    FROM (
      SELECT drowingnumber, specification, quantity, Finishing, supplier, note, 'inbound' AS type FROM inbound
      UNION ALL
      SELECT drowingnumber, specification, quantity, Finishing, supplier, note, 'outbound' AS type FROM outbound
    ) AS combined
    GROUP BY drowingnumber, specification, Finishing, supplier, note;
  `;
  const deleteQuery = `DELETE FROM inventory WHERE stock <= 0;`;

  db.query(truncateQuery, (err) => {
    if (err) return console.error('Error truncating inventory:', err);
    
    db.query(insertQuery, (err) => {
      if (err) return console.error('Error inserting inventory:', err);
      
      db.query(deleteQuery, (err) => {
        if (err) return console.error('Error deleting zero stock:', err);
        console.log('Inventory updated successfully');
      });
    });
  });
};

// 입고 데이터 저장
app.post('/api/inbound', (req, res) => {
  const items = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  for (const item of items) {
    if (!item.drowingnumber || !item.specification || !item.quantity || !item.date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (isNaN(parseInt(item.quantity)) || parseInt(item.quantity) <= 0) {
      return res.status(400).json({ error: 'Invalid quantity value' });
    }
  }

  const values = items.map(item => [
    uuidv4(),
    item.drowingnumber,
    item.specification,
    parseInt(item.quantity),
    item.Finishing || null,
    item.supplier || null,
    item.note || null,
    item.date,
    new Date().toISOString().slice(0, 19).replace('T', ' ')
  ]);

  const query = `
    INSERT INTO inbound 
    (id, drowingnumber, specification, quantity, Finishing, supplier, note, date, createdAt)
    VALUES ?
  `;

  db.query(query, [values], (err, result) => {
    if (err) {
      console.error('Error saving inbound data:', err);
      return res.status(500).json({ error: 'Failed to save data' });
    }
    
    updateInventory();
    res.status(201).json({ success: true, count: items.length });
  });
});

// 출고 데이터 저장
app.post('/api/outbound', (req, res) => {
  const items = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  for (const item of items) {
    if (!item.drowingnumber || !item.specification || !item.quantity || !item.date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (isNaN(parseInt(item.quantity)) || parseInt(item.quantity) <= 0) {
      return res.status(400).json({ error: 'Invalid quantity value' });
    }
  }

  // 재고 확인
  const checkStockQuery = `
    SELECT 
      i.drowingnumber, 
      i.specification,
      COALESCE(SUM(
        CASE WHEN type = 'inbound' THEN quantity ELSE -quantity END
      ), 0) AS currentStock
    FROM (
      SELECT drowingnumber, specification, quantity, 'inbound' AS type
      FROM inbound
      UNION ALL
      SELECT drowingnumber, specification, quantity, 'outbound' AS type
      FROM outbound
    ) AS i
    WHERE i.drowingnumber = ? AND i.specification = ?
    GROUP BY i.drowingnumber, i.specification
  `;

  const checkPromises = items.map(item => {
    return new Promise((resolve, reject) => {
      db.query(checkStockQuery, [item.drowingnumber, item.specification], (err, results) => {
        if (err) return reject(err);
        
        const currentStock = results[0]?.currentStock || 0;
        if (parseInt(item.quantity) > currentStock) {
          resolve({
            valid: false,
            message: `Insufficient stock for ${item.specification}. Current: ${currentStock}, Requested: ${item.quantity}`
          });
        } else {
          resolve({ valid: true });
        }
      });
    });
  });

  Promise.all(checkPromises)
    .then(results => {
      const invalidItem = results.find(r => !r.valid);
      if (invalidItem) {
        return res.status(400).json({ error: invalidItem.message });
      }

      // 출고 데이터 저장
      const values = items.map(item => [
        uuidv4(),
        item.drowingnumber,
        item.specification,
        parseInt(item.quantity),
        item.Finishing || null,
        item.supplier || null,
        item.note || null,
        item.date,
        new Date().toISOString().slice(0, 19).replace('T', ' ')
      ]);

      const query = `
        INSERT INTO outbound 
        (id, drowingnumber, specification, quantity, Finishing, supplier, note, date, createdAt)
        VALUES ?
      `;

      db.query(query, [values], (err, result) => {
        if (err) {
          console.error('Error saving outbound data:', err);
          return res.status(500).json({ error: 'Failed to save data' });
        }
        
        updateInventory();
        res.status(201).json({ success: true, count: items.length });
      });
    })
    .catch(err => {
      console.error('Error checking stock:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
});

// 입고 데이터 수정
app.put('/api/inbound/:id', (req, res) => {
  const { id } = req.params;
  const item = req.body;
  
  if (!item.drowingnumber || !item.specification || !item.quantity || !item.date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const query = `
    UPDATE inbound 
    SET 
      drowingnumber = ?,
      specification = ?,
      quantity = ?,
      Finishing = ?,
      supplier = ?,
      note = ?,
      date = ?
    WHERE id = ?
  `;

  const params = [
    item.drowingnumber,
    item.specification,
    parseInt(item.quantity),
    item.Finishing || null,
    item.supplier || null,
    item.note || null,
    item.date,
    id
  ];

  db.query(query, params, (err, result) => {
    if (err) {
      console.error('Error updating inbound data:', err);
      return res.status(500).json({ error: 'Failed to update data' });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }
    
    updateInventory();
    res.json({ success: true });
  });
});

// 출고 데이터 수정
app.put('/api/outbound/:id', (req, res) => {
  const { id } = req.params;
  const item = req.body;
  
  if (!item.drowingnumber || !item.specification || !item.quantity || !item.date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const query = `
    UPDATE outbound 
    SET 
      drowingnumber = ?,
      specification = ?,
      quantity = ?,
      Finishing = ?,
      supplier = ?,
      note = ?,
      date = ?
    WHERE id = ?
  `;

  const params = [
    item.drowingnumber,
    item.specification,
    parseInt(item.quantity),
    item.Finishing || null,
    item.supplier || null,
    item.note || null,
    item.date,
    id
  ];

  db.query(query, params, (err, result) => {
    if (err) {
      console.error('Error updating outbound data:', err);
      return res.status(500).json({ error: 'Failed to update data' });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }
    
    updateInventory();
    res.json({ success: true });
  });
});

// 입고 데이터 검색
app.get('/api/inbound', (req, res) => {
  const { search, date } = req.query;
  let query = 'SELECT * FROM inbound';
  const params = [];

  if (search || date) {
    query += ' WHERE ';
    const conditions = [];
    
    if (search) {
      conditions.push('(drowingnumber LIKE ? OR specification LIKE ? OR supplier LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (date) {
      conditions.push('date = ?');
      params.push(date);
    }
    
    query += conditions.join(' AND ');
  }

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching inbound data:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    
    const formattedData = results.map(item => ({
      ...item,
      quantity: Number(item.quantity).toLocaleString('ko-KR')
    }));
    
    res.json(formattedData);
  });
});

// 출고 데이터 검색
app.get('/api/outbound', (req, res) => {
  const { search, date } = req.query;
  let query = 'SELECT * FROM outbound';
  const params = [];

  if (search || date) {
    query += ' WHERE ';
    const conditions = [];
    
    if (search) {
      conditions.push('(drowingnumber LIKE ? OR specification LIKE ? OR supplier LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (date) {
      conditions.push('date = ?');
      params.push(date);
    }
    
    query += conditions.join(' AND ');
  }

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching outbound data:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    
    const formattedData = results.map(item => ({
      ...item,
      quantity: Number(item.quantity).toLocaleString('ko-KR')
    }));
    
    res.json(formattedData);
  });
});

// 재고 데이터 조회
app.get('/api/inventory', (req, res) => {
  const { dno, spec, fin, page = 1, limit = 20 } = req.query;
  const params = [];
  const conditions = [];

  // 검색 조건 만들기
  if (dno) {
    conditions.push('drowingnumber LIKE ?');
    params.push(`%${dno}%`);
  }
  if (spec) {
    conditions.push('specification LIKE ?');
    params.push(`%${spec}%`);
  }
  if (fin !== undefined) {
    if (fin === '') {
      // 후처리 검색창이 빈 문자열이면, Finishing IS NULL 또는 빈 문자열인 경우만 찾기
      conditions.push('(Finishing IS NULL OR Finishing = "")');
    } else {
      conditions.push('Finishing LIKE ?');
      params.push(`%${fin}%`);
    }
  }

  // 조건문 완성
  let whereClause = '';
  if (conditions.length > 0) {
    whereClause = ' WHERE ' + conditions.join(' AND ');
  }

  // 총 개수 조회 쿼리
  const countQuery = `SELECT COUNT(*) AS count FROM inventory ${whereClause}`;

  // 페이징 처리
  const offset = (page - 1) * limit;

  // 재고 목록 조회 쿼리
  const inventoryQuery = `
    SELECT * FROM inventory
    ${whereClause}
    ORDER BY drowingnumber, specification
    LIMIT ?, ?
  `;

  // 페이징 파라미터 추가
  const queryParams = [...params, parseInt(offset), parseInt(limit)];

  // 1) 총 개수 조회
  db.query(countQuery, params, (err, countResult) => {
    if (err) {
      console.error('Error counting inventory:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }

    const totalItems = countResult[0].count;
    const totalPages = Math.ceil(totalItems / limit);

    // 2) 재고 목록 조회
    db.query(inventoryQuery, queryParams, (err, inventoryResults) => {
      if (err) {
        console.error('Error fetching inventory:', err);
        return res.status(500).json({ error: 'Failed to fetch data' });
      }

      if (inventoryResults.length === 0) {
        // 데이터 없으면 바로 응답
        return res.json({
          items: [],
          totalItems,
          totalPages,
          currentPage: parseInt(page)
        });
      }

      const inboundConditions = [];
      const outboundConditions = [];
      const inboundParams = [];
      const outboundParams = [];

      for (const item of inventoryResults) {
        // 각 품목 조건
        inboundConditions.push(`(drowingnumber = ? AND specification = ? AND (Finishing = ? OR (Finishing IS NULL AND ? IS NULL)) AND (supplier = ? OR (supplier IS NULL AND ? IS NULL)) AND (note = ? OR (note IS NULL AND ? IS NULL)))`);
        outboundConditions.push(inboundConditions[inboundConditions.length - 1]); // 동일 조건 사용

        inboundParams.push(
          item.drowingnumber,
          item.specification,
          item.Finishing, item.Finishing,
          item.supplier, item.supplier,
          item.note, item.note
        );

        outboundParams.push(
          item.drowingnumber,
          item.specification,
          item.Finishing, item.Finishing,
          item.supplier, item.supplier,
          item.note, item.note
        );
      }

      // 입고 내역 조회 쿼리
      const inboundQuery = `
        SELECT * FROM inbound
        WHERE ${inboundConditions.join(' OR ')}
        ORDER BY date DESC
      `;

      // 출고 내역 조회 쿼리
      const outboundQuery = `
        SELECT * FROM outbound
        WHERE ${outboundConditions.join(' OR ')}
        ORDER BY date DESC
      `;

      // 4) 입출고 내역 한꺼번에 조회
      db.query(inboundQuery, inboundParams, (err, inboundResults) => {
        if (err) {
          console.error('Error fetching inbound records:', err);
          return res.status(500).json({ error: 'Failed to fetch inbound data' });
        }

        db.query(outboundQuery, outboundParams, (err, outboundResults) => {
          if (err) {
            console.error('Error fetching outbound records:', err);
            return res.status(500).json({ error: 'Failed to fetch outbound data' });
          }

          // 5) inventoryResults 각각에 inbound, outbound 내역 연결
          const inventoryItems = inventoryResults.map(item => {
            const inboundList = inboundResults.filter(r =>
              r.drowingnumber === item.drowingnumber &&
              r.specification === item.specification &&
              (r.Finishing || '') === (item.Finishing || '') &&
              (r.supplier || '') === (item.supplier || '') &&
              (r.note || '') === (item.note || '')
            );

            const outboundList = outboundResults.filter(r =>
              r.drowingnumber === item.drowingnumber &&
              r.specification === item.specification &&
              (r.Finishing || '') === (item.Finishing || '') &&
              (r.supplier || '') === (item.supplier || '') &&
              (r.note || '') === (item.note || '')
            );

            return {
              ...item,
              inbound: inboundList,
              outbound: outboundList
            };
          });

          // 6) 최종 응답
          res.json({
            items: inventoryItems,
            totalItems,
            totalPages,
            currentPage: parseInt(page)
          });
        });
      });
    });
  });
});

// 제품명 조회
app.get('/api/product', (req, res) => {
  const { dno, spec, fin } = req.query;
  let query = 'SELECT * FROM inventory';
  const params = [];
  const conditions = [];

  if (dno) {
    conditions.push('drowingnumber LIKE ?');
    params.push(`%${dno}%`);
  }
  
  if (spec) {
    conditions.push('specification LIKE ?');
    params.push(`%${spec}%`);
  }
  
  if (fin) {
    conditions.push('Finishing LIKE ?');
    params.push(`%${fin}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching products:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    
    res.json(results);
  });
});

// 개별 추천 엔드포인트
app.get('/api/suggestions/drowing', (req, res) => {
  const { term } = req.query;
  getSuggestions('drowingnumber', term, res);
});

app.get('/api/suggestions/product', (req, res) => {
  const { term } = req.query;
  getSuggestions('specification', term, res);
});

// 공통 추천 함수
function getSuggestions(column, term, res) {
  if (!term) {
    return res.status(400).json({ error: 'Term parameter is required' });
  }

  const query = `
    SELECT DISTINCT ${column} AS value 
    FROM (
      SELECT ${column} FROM inbound
      UNION
      SELECT ${column} FROM outbound
      UNION
      SELECT ${column} FROM inventory
    ) AS combined
    WHERE ${column} LIKE ?
    LIMIT 10
  `;

  db.query(query, [`%${term}%`], (err, results) => {
    if (err) {
      console.error('Error fetching suggestions:', err);
      return res.status(500).json({ error: 'Failed to fetch suggestions' });
    }
    
    res.json(results.map(r => r.value));
  });
}

// 월간 입출고 기록 조회
app.get('/api/monthly-records', (req, res) => {
  const { year, month } = req.query;
  
  if (!year || !month) {
    return res.status(400).json({ error: 'Year and month parameters are required' });
  }

  const startDate = `${year}-${month.padStart(2, '0')}-01`;
  const endDate = `${year}-${month.padStart(2, '0')}-31`;

  const query = `
    (SELECT 
      'inbound' AS type,
      id,
      drowingnumber,
      specification,
      quantity,
      Finishing,
      supplier,
      note,
      date
    FROM inbound
    WHERE date BETWEEN ? AND ?)
    UNION ALL
    (SELECT 
      'outbound' AS type,
      id,
      drowingnumber,
      specification,
      quantity,
      Finishing,
      supplier,
      note,
      date
    FROM outbound
    WHERE date BETWEEN ? AND ?)
    ORDER BY date DESC;
  `;

  db.query(query, [startDate, endDate, startDate, endDate], (err, results) => {
    if (err) {
      console.error('Error fetching monthly records:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    
    // 타입별로 분류
    const response = {
      inbound: results.filter(r => r.type === 'inbound'),
      outbound: results.filter(r => r.type === 'outbound')
    };
    
    res.json(response);
  });
});

app.post('/api/inventory/delete-by-condition', (req, res) => {
  const { drowingnumber, specification, Finishing, supplier, note } = req.body;

  console.log('삭제 요청 조건:', req.body);

  if (!drowingnumber || !specification) {
    return res.status(400).json({ error: "필수 삭제 조건이 부족합니다." });
  }

  let conditions = [`drowingnumber = ?`, `specification = ?`];
  let values = [drowingnumber, specification];

  // Finishing 조건
  if (Finishing === null || Finishing === '') {
    conditions.push(`(Finishing IS NULL OR Finishing = '')`);
  } else {
    conditions.push(`Finishing = ?`);
    values.push(Finishing);
  }

  // supplier 조건
  if (supplier === null || supplier === '') {
    conditions.push(`(supplier IS NULL OR supplier = '')`);
  } else {
    conditions.push(`supplier = ?`);
    values.push(supplier);
  }

  // note 조건
  if (note === null || note === '') {
    conditions.push(`(note IS NULL OR note = '')`);
  } else {
    conditions.push(`note = ?`);
    values.push(note);
  }

  const whereClause = conditions.join(' AND ');

  // inventory 삭제
  db.query(`DELETE FROM inventory WHERE ${whereClause}`, values, (invErr, invResult) => {
    if (invErr) return res.status(500).json({ error: "inventory 삭제 실패" });
    if (invResult.affectedRows === 0) return res.status(404).json({ error: "해당 재고를 찾을 수 없습니다" });

    // inbound 삭제
    db.query(`DELETE FROM inbound WHERE ${whereClause}`, values, (inErr) => {
      if (inErr) console.error("inbound 삭제 실패:", inErr);

      // outbound 삭제
      db.query(`DELETE FROM outbound WHERE ${whereClause}`, values, (outErr) => {
        if (outErr) console.error("outbound 삭제 실패:", outErr);

        return res.json({ success: true });
      });
    });
  });
});

// 재고 항목 삭제
app.delete('/api/inventory/:id', (req, res) => {
  const { id } = req.params;

  const query = `DELETE FROM inventory WHERE id = ?`;
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error deleting inventory item:', err);
      return res.status(500).json({ error: '삭제 중 오류 발생' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '해당 재고를 찾을 수 없습니다' });
    }

    res.json({ success: true });
  });
});

// 루트 페이지 요청
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// 서버 시작
app.listen(port, '0.0.0.0', () => {
  console.log(`서버 실행 중: http://localhost:${port}`);
});