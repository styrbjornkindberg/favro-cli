const fs = require('fs');
['kanban', 'felrapporter', 'onskemal', 'backlog', 'releases'].forEach(type => {
  const file = `/tmp/context_${type}.json`;
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`\n================================`);
    console.log(`BOARD: ${data.metadata ? data.metadata.name : 'Unknown'}`);
    console.log(`COLS:  ${data.columns ? data.columns.map(c => c.name).join(', ') : 'none'}`);
    console.log(`FIELDS:${data.customFields ? data.customFields.map(f => f.name + ' ('+f.type+')').join(', ') : 'none'}`);
    if (data.cards && data.cards.length > 0) {
      console.log(`CARD[0]: cardId=${data.cards[0].id}, commonId=${data.cards[0].widgetCommonId || 'undefined'}`);
    }
  } catch(e) { console.error(file, e); }
});
