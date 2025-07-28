import api, { route } from '@forge/api';


export async function getTicketsWithFilteredChildren(payload) {
  try {
    console.log('Function getTicketsWithFilteredChildren called');
    console.log('Received Payload:', payload);
    // Validate input parameters
    const jqlQuery = payload.jqlQuery;
    const attributes = payload.attributes;
    console.log('JQL Query:', jqlQuery);
    console.log('Attributes:', attributes);
    if (!jqlQuery || typeof jqlQuery !== 'string') {
      throw new Error('jqlQuery parameter is required and must be a string');
    }
    
    if (!attributes || attributes.length === 0) {
      throw new Error('attributes parameter is required and must be non-empty');
    }

    // Step 1: Get all parent tickets based on the initial JQL query
    const parentTicketsResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: jqlQuery,
        fields: ['key', 'summary'],
        maxResults: 1000 // Adjust as needed
      })
    });

    const parentTicketsData = await parentTicketsResponse.json();
    
    if (!parentTicketsData.issues || parentTicketsData.issues.length === 0) {
      return [];
    }

    const parentIssueKeys = parentTicketsData.issues.map(issue => issue.key);
    const filteredParentKeys = [];

    // Step 2: For each parent ticket, check if all its children satisfy the attribute conditions
    for (const parentKey of parentIssueKeys) {
      // Build JQL to find children of this parent
      const childrenJql = `parent = "${parentKey}"`;
      
      // Get all children of this parent
      
      let allChildrenSatisfyConditions = true;
      
      // Build JQL to check if any children DON'T satisfy the conditions
      // We'll use negative logic: if we find any child that doesn't satisfy conditions, exclude the parent
      //const negatedConditions = attributes.map(attr => `NOT (${attr})`).join(' OR ');
      const childrenFilterJql = `parent = "${parentKey}" AND (${attributes})`;
      console.log(`Checking children for parent ${parentKey} with JQL: ${childrenFilterJql}`);
      const violatingChildrenResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jql: childrenFilterJql,
          fields: ['key'],
          maxResults: 1
        })
      });

      const violatingChildrenData = await violatingChildrenResponse.json();
      
      // If no children violate the conditions, all children satisfy them
      if (!violatingChildrenData.issues || violatingChildrenData.issues.length === 0) {
        filteredParentKeys.push(parentKey);
      }
    }

    return filteredParentKeys;

  } catch (error) {
    console.error('Error in getTicketsWithFilteredChildren:', error);
    throw new Error(`Failed to retrieve tickets with filtered children: ${error.message}`);
  }
}

