const fs = require('fs');
['kanban', 'felrapporter', 'onskemal', 'backlog', 'releases'].forEach(type => {
  const file = `/tmp/context_${type}.json`;
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`\n================================`);
    console.log(`BOARD: ${data.board.name}`);
    console.log(`COLS:  ${data.columns ? data.columns.map(c => c.name).join(', ') : 'none'}`);
    console.log(`FIELDS:${data.customFields ? data.customFields.map(f => f.name).join(', ') : 'none'}`);
    if (data.cards && data.cards.length > 0) {
      console.log(`CARD[0]: cardId=${data.cards[0].cardId}, commonId=${data.cards[0].widgetCommonId}`);
    }
  } catch(e) { console.error(file, e); }
});
