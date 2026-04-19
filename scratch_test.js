const { buildXodr } = require('./src/xodrSerializer');

const spec = {
  header: { name: 'test' },
  roads: [
    { id: '1', points: [{x:0, y:0}, {x:10, y:0}], junction: '1' }
  ],
  junctions: [
    {
      id: '1',
      connections: [
        { incomingRoad: '1', connectingRoad: '1', laneLinks: [{from: '1', to: '-1'}] }
      ]
    }
  ]
};

console.log(buildXodr(spec));
