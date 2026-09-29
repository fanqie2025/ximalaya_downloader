import Datastore from 'nedb'
import {dbDirPath} from '../common/config.js'
import path from 'path'
/**
 * 记录专辑
 */

const db = new Datastore({
    filename : path.join(dbDirPath(),'db','file','track.db'),
    autoload: true
});


const trackDB = {}

// 插入数据
trackDB.insert = (entity) => {
    return new Promise((resolve, reject) => {
        db.insert(entity, (err, newDoc) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(newDoc)
            }
        });
    })
}

trackDB.count = (query) => {
    // 计算符合条件的文档数量
    return new Promise((resolve, reject) => {
        db.count(query, (err, count) => {
            if (err) {
                return reject(err);
            } else {
                return resolve(count);
            }
        });
    });
};

trackDB.find = (entity, sort, limit) => {
    // 查找数据
    return new Promise((resolve, reject) => {
        let query = db.find(entity);
        if (limit) {
            query = query.limit(limit);
        }
        if (sort){
            query.sort(sort)
        }
        query.exec((err, docs) => {
            if (err) {
                return reject(err);
            } else {
                return resolve(docs);
            }
        });
    });
};

trackDB.findOne = (query) => {
    return new Promise((resolve, reject) => {
        db.findOne(query, (err, doc) => {
            if (err) {
                return reject(err);
            } else {
                return resolve(doc);
            }
        });
    });
};


trackDB.update = (condition, setEntity) => {
    // 更新数据
    // 注意：NeDB 的 db.update 默认只改**第一条**命中的文档，补路径这种
    // 「同一个集号可能有多条重复记录」的场合必须显式 multi:true（见 updateMulti）。
    return new Promise((resolve, reject) => {
        db.update(condition, {$set: setEntity}, (err, numReplaced) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(numReplaced)
            }
        });
    })
}

trackDB.updateMulti = (condition, setEntity) => {
    return new Promise((resolve, reject) => {
        db.update(condition, {$set: setEntity}, {multi: true}, (err, numReplaced) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(numReplaced)
            }
        })
    })
}

// 删除数据
// 注意：options 传 {} 时 NeDB 的 multi 默认是 false —— 这个函数只删**一条**。
// 要删一批请用 removeMany / removeById。
trackDB.remove = (condition) => {
    return new Promise((resolve, reject) => {
        db.remove(condition, {}, (err, numReplaced) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(numReplaced)
            }
        })
    })
}

trackDB.removeMany = (condition) => {
    return new Promise((resolve, reject) => {
        db.remove(condition, {multi: true}, (err, numRemoved) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(numRemoved)
            }
        })
    })
}

trackDB.removeById = (id) => {
    return new Promise((resolve, reject) => {
        db.remove({_id: id}, {}, (err, numRemoved) => {
            if (err) {
                return reject(err)
            } else {
                return resolve(numRemoved)
            }
        })
    })
}
export {
    trackDB
}
