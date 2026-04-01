import itemCmp from "c/orderItem";
import getOrders from "@salesforce/apex/OrderController.getOrders";
import titleLabel from "@salesforce/label/c.Order_Title";
import amountField from "@salesforce/schema/Invoice__c.Amount__c";
import configType from "@salesforce/schema/App_Config__mdt";
import missingLwc from "c/missingBundle";
import missingApex from "@salesforce/apex/MissingController.run";
import missingLabel from "@salesforce/label/c.Missing_Label";
import missingSchema from "@salesforce/schema/Missing_Object__c";


export default class OrderSummary {}
