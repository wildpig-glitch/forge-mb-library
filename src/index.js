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
    console.log('Fetching parent tickets...');
    const parentTicketsResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: jqlQuery,
        fields: ['key', 'summary'],
        maxResults: 1000
      })
    });

    const parentTicketsData = await parentTicketsResponse.json();
    
    if (!parentTicketsData.issues || parentTicketsData.issues.length === 0) {
      console.log('No parent tickets found');
      return [];
    }

    const parentIssueKeys = parentTicketsData.issues.map(issue => issue.key);
    console.log(`Found ${parentIssueKeys.length} parent tickets`);

    // Step 2: Try optimized approach first - get all children that satisfy conditions
    try {
      console.log('Attempting optimized JQL approach...');
      const optimizedResult = await getFilteredParentsOptimized(parentIssueKeys, attributes);
      if (optimizedResult !== null) {
        console.log(`Optimized approach succeeded, found ${optimizedResult.length} filtered parents`);
        return optimizedResult;
      }
    } catch (error) {
      console.log('Optimized approach failed, falling back to batch processing:', error.message);
    }

    // Step 3: Fallback to parallel batch processing
    console.log('Using parallel batch processing approach...');
    const batchResult = await getFilteredParentsBatched(parentIssueKeys, attributes);
    console.log(`Batch approach completed, found ${batchResult.length} filtered parents`);
    return batchResult;

  } catch (error) {
    console.error('Error in getTicketsWithFilteredChildren:', error);
    throw new Error(`Failed to retrieve tickets with filtered children: ${error.message}`);
  }
}

// Optimized approach: Use a single JQL query to find all children that satisfy conditions
async function getFilteredParentsOptimized(parentIssueKeys, attributes) {
  try {
    // Build JQL to find all children of any parent that satisfy the conditions
    const parentKeysJql = parentIssueKeys.map(key => `"${key}"`).join(', ');
    const childrenWithConditionsJql = `parent in (${parentKeysJql}) AND (${attributes})`;
    
    console.log(`Optimized JQL query: ${childrenWithConditionsJql}`);
    
    // Get all children that satisfy the conditions
    const childrenResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: childrenWithConditionsJql,
        fields: ['key', 'parent'],
        maxResults: 10000 // Large number to get all children
      })
    });

    const childrenData = await childrenResponse.json();
    
    if (!childrenData.issues) {
      return [];
    }

    // Get parents that have children satisfying conditions
    const parentsWithSatisfyingChildren = new Set(
      childrenData.issues.map(child => child.fields.parent?.key).filter(Boolean)
    );

    // Now check which parents have ALL their children satisfying conditions
    // We need to get total child count for each parent
    const parentChildCounts = await getParentChildCounts(parentIssueKeys);
    const satisfyingChildCounts = {};
    
    // Count children per parent that satisfy conditions
    childrenData.issues.forEach(child => {
      const parentKey = child.fields.parent?.key;
      if (parentKey) {
        satisfyingChildCounts[parentKey] = (satisfyingChildCounts[parentKey] || 0) + 1;
      }
    });

    // Filter parents where all children satisfy conditions
    const filteredParents = parentIssueKeys.filter(parentKey => {
      const totalChildren = parentChildCounts[parentKey] || 0;
      const satisfyingChildren = satisfyingChildCounts[parentKey] || 0;
      
      // If parent has no children, do not include it
      if (totalChildren === 0) {
        return false;
      }
      
      // Include parent only if all children satisfy conditions
      return totalChildren === satisfyingChildren;
    });

    return filteredParents;
    
  } catch (error) {
    console.log('Optimized approach error:', error.message);
    return null; // Signal to use fallback approach
  }
}

// Get total child count for each parent
async function getParentChildCounts(parentIssueKeys) {
  const parentKeysJql = parentIssueKeys.map(key => `"${key}"`).join(', ');
  const allChildrenJql = `parent in (${parentKeysJql})`;
  
  const allChildrenResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jql: allChildrenJql,
      fields: ['key', 'parent'],
      maxResults: 10000
    })
  });

  const allChildrenData = await allChildrenResponse.json();
  const childCounts = {};
  
  // Initialize counts
  parentIssueKeys.forEach(key => {
    childCounts[key] = 0;
  });
  
  // Count children per parent
  if (allChildrenData.issues) {
    allChildrenData.issues.forEach(child => {
      const parentKey = child.fields.parent?.key;
      if (parentKey) {
        childCounts[parentKey] = (childCounts[parentKey] || 0) + 1;
      }
    });
  }
  
  return childCounts;
}

// Fallback approach: Process parents in parallel batches
async function getFilteredParentsBatched(parentIssueKeys, attributes) {
  const BATCH_SIZE = 15; // Process 15 parents at a time
  const filteredParentKeys = [];
  
  // Process parents in batches
  for (let i = 0; i < parentIssueKeys.length; i += BATCH_SIZE) {
    const batch = parentIssueKeys.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(parentIssueKeys.length / BATCH_SIZE)} (${batch.length} parents)`);
    
    // Process batch in parallel
    const batchPromises = batch.map(parentKey => checkParentChildren(parentKey, attributes));
    const batchResults = await Promise.all(batchPromises);
    
    // Collect successful results
    batchResults.forEach((result, index) => {
      if (result.success) {
        filteredParentKeys.push(batch[index]);
      }
    });
    
    // Add small delay between batches to avoid overwhelming the API
    if (i + BATCH_SIZE < parentIssueKeys.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return filteredParentKeys;
}

// Check if all children of a parent satisfy the conditions
async function checkParentChildren(parentKey, attributes) {
  try {
    // Check if any children DON'T satisfy the conditions using negative logic
    const negatedConditions = `NOT (${attributes})`;
    const violatingChildrenJql = `parent = "${parentKey}" AND (${negatedConditions})`;
    
    const violatingChildrenResponse = await api.asApp().requestJira(route`/rest/api/3/search`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: violatingChildrenJql,
        fields: ['key'],
        maxResults: 1 // We only need to know if any exist
      })
    });

    const violatingChildrenData = await violatingChildrenResponse.json();
    
    // If no children violate the conditions, all children satisfy them
    const success = !violatingChildrenData.issues || violatingChildrenData.issues.length === 0;
    return { success };
    
  } catch (error) {
    console.error(`Error checking children for parent ${parentKey}:`, error);
    return { success: false };
  }
}

